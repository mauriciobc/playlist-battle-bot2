import type { Db } from "../db/index.js";
import {
  collectingGameIdsPastDeadline,
  gameIdsWithStatus,
  gamesInRound,
  interruptedCreations,
  loadGame,
  loadOpenGame,
  saveGame,
  saveGameState,
  setGameStatus,
  unacceptedGameIdsPastDeadline,
  type InterruptedCreation,
} from "../db/games.js";
import { expirePendingInvites, loadPlayers } from "../db/players.js";
import { loadTunes } from "../db/tunes.js";
import {
  RESOLVED_ROUND_STATUSES,
  announcedRoundsOfOpenGames,
  clearEarlyClosedPoll,
  duePolls,
  isPollOpen,
  loadRound,
  markPollCleanedUp,
  markRoundResolved,
  openPollByStatus,
  pollsNeedingCleanup,
  unexpiredPolls,
  watchPollVotes,
  type OpenPoll,
  type PollCleanup,
  type WatchedPoll,
} from "../db/rounds.js";
import { completeCreation } from "../handlers/publicCommand.js";
import type { HandlerDeps } from "../handlers/deps.js";
import { removeStatus } from "../handlers/closure.js";
import { reply } from "../mastodon/reply.js";
import { tallyPoll, pollSnapshot, postSideEffect, type PollSnapshot, type TallyInput } from "../mastodon/posts.js";
import { FIRST_ROUND, isTerminal, type Game, type Tally } from "../game/types.js";
import { finalizeCollection, startRound, resolveRound } from "../game/engine.js";
import { errorMessage } from "../errors.js";
import { addSeconds, MS_PER_SECOND } from "../time.js";
import { m } from "../i18n/index.js";
import { claimKey, exclusively, isClaimed } from "./claims.js";
import {
  advanceAfterRound,
  emitRound,
  emitFinale,
  postRoundResult,
  recoverRoundResult,
  recoverRoundResults,
} from "./roundState.js";

type EarlyCloseConfig = {
  enabled: boolean;
  /** Minimum poll age before early close is allowed. */
  minAgeSec: number;
  /** Votes unchanged for this long → close early. */
  stagnationSec: number;
};

export type SchedulerDeps = {
  handler: HandlerDeps;
  /** Absent or disabled → polls only resolve at natural expiry. */
  earlyClose?: EarlyCloseConfig;
};

/** Stagnation close of a still-open poll: its live tallies, and how to remove its status. */
type EarlyClose = { tallies: Tally[]; removePoll: () => Promise<boolean> };

type RoundRef = { gameId: string; round: number };

/**
 * Sweep acceptance + submission windows (PRD §5.2, §5.4, §7).
 */
export async function checkDeadlines(deps: SchedulerDeps): Promise<void> {
  const { handler } = deps;
  const now = handler.now();
  const expiredGames = await expireUnacceptedGames(handler, now);
  // Acceptance window closed with some accepts → expire remaining pending challengers.
  const expiredPendingInvites = expirePendingInvites(handler.db, now);
  const finalizedGames = await finalizeGamesPastSubmissionDeadline(handler, now);
  const reemittedRounds = await reemitAnnouncedRounds(handler);

  handler.logger?.debug(
    { expiredGames, expiredPendingInvites, finalizedGames, reemittedRounds },
    "deadline sweep complete",
  );
}

/** Acceptance window: INVITED games past deadline with zero accepts → EXPIRED. Returns how many. */
async function expireUnacceptedGames(handler: HandlerDeps, now: Date): Promise<number> {
  const gameIds = unacceptedGameIdsPastDeadline(handler.db, now);
  for (const gameId of gameIds) {
    setGameStatus(handler.db, gameId, "INVITED", "EXPIRED", now);
    const game = loadGame(handler.db, gameId);
    if (game) await postSideEffect(handler.client, game, "expired");
  }
  return gameIds.length;
}

/** Submission window: COLLECTING games past deadline → finalize. Returns how many. */
async function finalizeGamesPastSubmissionDeadline(handler: HandlerDeps, now: Date): Promise<number> {
  const gameIds = collectingGameIdsPastDeadline(handler.db, now);
  for (const gameId of gameIds) {
    await finalizeCollecting(handler, gameId);
  }
  return gameIds.length;
}

/**
 * v1.1 1.4: announced rounds past their replacement deadline → re-enter
 * emitRound (availability re-check → publish / exclude / walkover). Returns how many.
 */
async function reemitAnnouncedRounds(handler: HandlerDeps): Promise<number> {
  const rounds = announcedRoundsOfOpenGames(handler.db);
  for (const { gameId, round } of rounds) {
    await emitRound(handler, gameId, round);
  }
  return rounds.length;
}

async function finalizeCollecting(handler: HandlerDeps, gameId: string): Promise<void> {
  const db = handler.db;
  const game = loadGame(db, gameId)!;
  const now = handler.now();
  const result = finalizeCollection(game, loadPlayers(db, gameId), loadTunes(db, gameId), now);
  if (!saveGameState(db, result.game, result.players, "COLLECTING")) return;

  if (result.outcome === "fizzled") {
    await postSideEffect(handler.client, result.game, "fizzled");
  } else if (result.outcome === "default_win") {
    const winner = result.players.find((p) => p.accountId === result.defaultWinnerId);
    await postSideEffect(handler.client, result.game, "default_win", winner?.acct);
    // The game is already in FINALE: post the summary and close it right away.
    await emitFinale(handler, gameId);
  } else {
    saveGame(db, startRound(result.game, FIRST_ROUND, now));
    await emitRound(handler, gameId, FIRST_ROUND);
  }
}

/**
 * Sweep open polls past expires_at → tally → resolve → next round or finale (PRD §5.5/§5.6).
 * Also consumes poll-expired notifications via checkPollNotification,
 * and (when earlyClose is enabled) resolves stagnant polls before expiry.
 */
export async function checkPolls(deps: SchedulerDeps): Promise<void> {
  const { handler } = deps;
  const cleanedRounds = await retryPollCleanup(handler);
  for (const { gameId, round } of cleanedRounds) {
    if (!await recoverRoundResult(handler, gameId, round)) continue;
    await advanceAfterRound(handler, gameId, round);
  }

  const due = duePolls(handler.db, handler.now());
  for (const poll of due) {
    await resolvePoll(handler, poll);
  }

  if (deps.earlyClose?.enabled) {
    await checkStagnantPolls(handler, deps.earlyClose);
  }

  handler.logger?.debug(
    {
      cleanedTerminal: cleanedRounds.length,
      dueExpired: due.length,
      earlyClose: deps.earlyClose?.enabled ?? false,
    },
    "poll sweep complete",
  );
}

/**
 * Retry poll deletion for rounds that must stop collecting votes: open polls
 * of terminal games, and polls flagged cleanup-pending. Returns the rounds of
 * still-open games whose poll was cleaned up here.
 */
async function retryPollCleanup(handler: HandlerDeps): Promise<RoundRef[]> {
  const cleaned: RoundRef[] = [];
  for (const poll of pollsNeedingCleanup(handler.db)) {
    if (!mustStopCollecting(poll)) continue;
    const removed = !poll.pollStatusId ||
      (await removeStatus(handler, poll.pollStatusId, { gameId: poll.gameId, round: poll.round }));
    if (!removed) continue;
    const resolvedHere = markPollCleanedUp(handler.db, poll.gameId, poll.round);
    if (resolvedHere && !isTerminal(poll.gameStatus)) cleaned.push({ gameId: poll.gameId, round: poll.round });
  }
  return cleaned;
}

/** Every row the cleanup query returns must stop collecting, except the live poll of an open game. */
function mustStopCollecting(poll: PollCleanup): boolean {
  const isLivePoll = poll.roundStatus === "poll_open" && !isTerminal(poll.gameStatus);
  return !isLivePoll;
}

/**
 * Resolve still-open polls whose vote totals stopped changing (Mastodon has no
 * early-close API — we tally live counts, resolve bot-side, then delete the
 * poll status so late votes can't land on a decided round).
 *
 * Guardrails: poll must be older than minAgeSec, votes unchanged for
 * stagnationSec, and tallies must be visible (hide_totals off).
 */
async function checkStagnantPolls(handler: HandlerDeps, earlyClose: EarlyCloseConfig): Promise<void> {
  const now = handler.now();
  for (const poll of unexpiredPolls(handler.db, now)) {
    if (isClaimed(claimKey.poll(poll.gameId, poll.round))) continue;
    const snapshot = await liveVotes(handler, poll);
    if (!snapshot) continue;
    const votesChangedAt = votesLastChangedAt(handler.db, poll, snapshot, now);
    if (!votesChangedAt || !isStagnant(poll, votesChangedAt, now, earlyClose)) continue;

    await resolvePoll(handler, poll, {
      tallies: snapshot.tallies,
      removePoll: () => removeEarlyClosedPoll(handler, poll),
    });
  }
}

/** The poll's live votes; null when tallies are hidden or the API failed. */
async function liveVotes(handler: HandlerDeps, poll: WatchedPoll): Promise<PollSnapshot | null> {
  try {
    return await pollSnapshot(handler.client, poll.pollId, JSON.parse(poll.optionMapJson));
  } catch {
    return null; // transient API error — natural expiry still resolves this poll
  }
}

/**
 * Record the votes seen on a watched poll and return when they last changed —
 * null when they changed since the last look, so the poll is not stagnant.
 */
function votesLastChangedAt(db: Db, poll: WatchedPoll, snapshot: PollSnapshot, now: Date): Date | null {
  const openedAt = pollOpenedAt(poll);
  const tallyJson = JSON.stringify(
    [...snapshot.tallies].sort((a, b) => a.accountId.localeCompare(b.accountId)),
  );
  const recordSeen = (changedAt: Date): void =>
    watchPollVotes(db, poll, { totalVotes: snapshot.totalVotes, tallyJson, changedAt });

  const firstSight = poll.watchedTallyJson === null && poll.watchedVotes === null;
  if (firstSight) {
    const changedAt = snapshot.totalVotes === 0 ? openedAt : now;
    recordSeen(changedAt);
    return changedAt;
  }

  // Legacy rows tracked only the vote total, not the per-option tally.
  const isLegacyRow = poll.watchedTallyJson === null;
  const votesChanged = isLegacyRow
    ? poll.watchedVotes !== snapshot.totalVotes
    : poll.watchedTallyJson !== tallyJson;
  if (votesChanged) {
    recordSeen(now);
    return null;
  }
  const changedAt = new Date(poll.votesChangedAt ?? openedAt.toISOString());
  if (isLegacyRow) recordSeen(changedAt); // adopt the fingerprint
  return changedAt;
}

function pollOpenedAt(poll: WatchedPoll): Date {
  return addSeconds(new Date(poll.pollExpiresAt), -poll.pollDurationSec);
}

/** Old enough, votes still for long enough, and not expired yet (the due sweep owns expired polls). */
function isStagnant(poll: WatchedPoll, votesChangedAt: Date, now: Date, earlyClose: EarlyCloseConfig): boolean {
  const ageSec = (now.getTime() - pollOpenedAt(poll).getTime()) / MS_PER_SECOND;
  const stillSec = (now.getTime() - votesChangedAt.getTime()) / MS_PER_SECOND;
  const oldEnough = ageSec >= earlyClose.minAgeSec;
  const votesSettled = stillSec >= earlyClose.stagnationSec;
  const stillOpen = new Date(poll.pollExpiresAt).getTime() > now.getTime();
  return oldEnough && votesSettled && stillOpen;
}

/** Delete the early-closed poll's status, then forget the poll. False when the deletion failed. */
async function removeEarlyClosedPoll(handler: HandlerDeps, poll: WatchedPoll): Promise<boolean> {
  const context = { gameId: poll.gameId, round: poll.round };
  if (!(await removeStatus(handler, poll.pollStatusId, context))) return false;
  clearEarlyClosedPoll(handler.db, poll);
  return true;
}

/** Entry point for `type=poll` notifications (fast path) — resolves immediately if due. */
export async function checkPollNotification(
  deps: SchedulerDeps,
  statusId: string | null,
): Promise<boolean> {
  if (!statusId) return false;
  const { handler } = deps;
  const poll = openPollByStatus(handler.db, statusId);
  if (!poll?.pollExpiresAt) return false;
  const stillRunning = new Date(poll.pollExpiresAt).getTime() > handler.now().getTime();
  if (stillRunning) return false;
  await resolvePoll(handler, poll);
  return true;
}

/**
 * Tally and resolve one open poll. `early` (stagnation close) supplies live
 * tallies and removes the still-open poll status before the result posts.
 */
async function resolvePoll(handler: HandlerDeps, poll: OpenPoll, early?: EarlyClose): Promise<void> {
  // The 60s sweep and the notification fast-path run on independent timers, so
  // both can race for the same poll: whoever fails to claim defers to the holder
  // (checkStagnantPolls tests the same key); the re-check under the claim skips
  // rows the holder already resolved.
  await exclusively(claimKey.poll(poll.gameId, poll.round), async () => {
    if (!livePollGame(handler.db, poll)) return;
    const tallies = early?.tallies ??
      (await tallyPoll(handler.client, poll.pollId, JSON.parse(poll.optionMapJson) as Record<string, string>));
    const game = livePollGame(handler.db, poll);
    if (!game) return;

    const result = persistPollResolution(handler, {
      game,
      round: poll.round,
      tallies,
      pollCleanupPending: early !== undefined,
    });
    if (!loadOpenGame(handler.db, poll.gameId)) return;
    if (early && !(await early.removePoll())) return;
    if (!await postRoundResult(handler, poll.gameId, poll.round, result)) return;
    await advanceAfterRound(handler, poll.gameId, poll.round);
  });
}

/** The game while the poll is still the open poll of the round it is on; null otherwise. */
function livePollGame(db: Db, poll: OpenPoll): Game | null {
  if (!isPollOpen(db, poll.gameId, poll.round, poll.pollId)) return null;
  const game = loadGame(db, poll.gameId);
  return game?.status === "ROUND" && game.currentRound === poll.round ? game : null;
}

/**
 * Score the round from its tallies and persist game, players and round in one
 * transaction. Returns the result to post.
 */
function persistPollResolution(
  handler: HandlerDeps,
  resolution: { game: Game; round: number; tallies: Tally[]; pollCleanupPending: boolean },
): TallyInput {
  const db = handler.db;
  const { game, round } = resolution;
  const outcome = resolveRound({
    game,
    players: loadPlayers(db, game.id),
    tallies: resolution.tallies,
    roundNumber: round,
    now: handler.now(),
  });
  const winner = outcome.players.find((p) => p.accountId === outcome.winnerAccountId);
  const result: TallyInput = {
    round,
    winnerAcct: winner?.acct ?? null,
    potAwarded: outcome.potAwarded,
    wasTie: outcome.winnerAccountId === null,
    newPot: outcome.game.pot,
    potSplit: outcome.finalSplit,
  };
  db.transaction(() => {
    if (!saveGameState(db, outcome.game, outcome.players, "ROUND")) {
      throw new Error(`Game ${game.id} changed state before round ${round} could be resolved`);
    }
    markRoundResolved(db, game.id, round, {
      winnerAccountId: outcome.winnerAccountId,
      metaPatch: outcome.finalSplit ? { finalSplit: outcome.finalSplit } : {},
      pollCleanupPending: resolution.pollCleanupPending,
      resolutionJson: JSON.stringify(result),
    });
  })();
  return result;
}

/**
 * CREATED games whose creation was interrupted: finish them, except a
 * private-visibility creation, which cannot host the public thread and is
 * cancelled with a private notice.
 */
async function resumeCreatedGames(handler: HandlerDeps): Promise<void> {
  for (const creation of interruptedCreations(handler.db)) {
    if (creation.creationVisibility === "private") {
      await cancelPrivateCreation(handler, creation);
    } else {
      await finishCreation(handler, creation);
    }
  }
}

async function cancelPrivateCreation(handler: HandlerDeps, creation: InterruptedCreation): Promise<void> {
  if (!setGameStatus(handler.db, creation.id, "CREATED", "CANCELLED", handler.now())) return;
  try {
    await reply(handler, creation.creationStatusId, m().sideCancelled(creation.theme), "private", {
      idempotencyKey: `pb:v1:creation:${creation.creationStatusId}:private-cancel`,
    });
  } catch (err) {
    handler.logger?.warn({ gameId: creation.id, err }, "private creation cancellation notice failed");
  }
}

async function finishCreation(handler: HandlerDeps, creation: InterruptedCreation): Promise<void> {
  try {
    await completeCreation(
      handler,
      creation.id,
      creation.creationStatusId,
      creation.creationVisibility === "unlisted" ? "unlisted" : "public",
    );
  } catch (err) {
    handler.logger?.warn(
      { gameId: creation.id, err: errorMessage(err) },
      "created game recovery failed; will retry",
    );
  }
}

/**
 * Boot-time / periodic resume of open games (PRD §7 restart).
 * Sweeps deadlines + polls, then recovers games stuck mid-transition:
 * - READY (crash before round 1 emit) → start round 1
 * - ROUND (crash between resolving and posting) → post result, advance
 * - FINALE (crash before close) → post finale thread + close
 */
export async function resumeOpenGames(deps: SchedulerDeps): Promise<void> {
  const { handler } = deps;
  await resumeCreatedGames(handler);
  await checkDeadlines(deps);
  await checkPolls(deps);

  const readyStuck = await startStuckReadyGames(handler);
  const inFlightRounds = await resumeInFlightRounds(handler);
  const stuckFinales = await resumeStuckFinales(handler);

  handler.logger?.debug({ readyStuck, inFlightRounds, stuckFinales }, "game recovery sweep complete");
}

/** READY games that finished collection but never emitted round 1. Returns how many. */
async function startStuckReadyGames(handler: HandlerDeps): Promise<number> {
  const gameIds = gameIdsWithStatus(handler.db, "READY");
  for (const gameId of gameIds) {
    const started = startRound(loadGame(handler.db, gameId)!, FIRST_ROUND, handler.now());
    if (!saveGame(handler.db, started, "READY")) continue;
    await emitRound(handler, gameId, FIRST_ROUND);
  }
  return gameIds.length;
}

/** ROUND games: post any unposted results, then emit or advance the current round. Returns how many. */
async function resumeInFlightRounds(handler: HandlerDeps): Promise<number> {
  const games = gamesInRound(handler.db);
  for (const { id, currentRound } of games) {
    await resumeRound(handler, id, currentRound > 0 ? currentRound : FIRST_ROUND);
  }
  return games.length;
}

async function resumeRound(handler: HandlerDeps, gameId: string, round: number): Promise<void> {
  if (!await recoverRoundResults(handler, gameId, round)) return;
  const persisted = loadRound(handler.db, gameId, round);
  if (!persisted) {
    await emitRound(handler, gameId, round);
  } else if (RESOLVED_ROUND_STATUSES.includes(persisted.status)) {
    await advanceAfterRound(handler, gameId, round);
  }
}

/** FINALE games that never posted their finale or closed. Returns how many. */
async function resumeStuckFinales(handler: HandlerDeps): Promise<number> {
  const gameIds = gameIdsWithStatus(handler.db, "FINALE");
  for (const gameId of gameIds) {
    await emitFinale(handler, gameId);
  }
  return gameIds.length;
}
