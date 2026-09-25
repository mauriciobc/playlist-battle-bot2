import type { Db } from "../db/index.js";
import {
  advanceCurrentRound,
  isLiveRound,
  loadFinaleQueueUrl,
  loadGame,
  loadOpenGame,
  saveBattlePlaylistId,
  saveFinaleQueueUrl,
  setGamePot,
  setGameStatus,
} from "../db/games.js";
import { awardPoints, loadPlayers } from "../db/players.js";
import { loadTunes } from "../db/tunes.js";
import {
  RESOLVED_ROUND_STATUSES,
  deleteAnnouncedRound,
  loadRound,
  loadRoundWinners,
  loadRounds,
  markResolutionPosted,
  openAnnouncedRound,
  pollOptionAccounts,
  roundMeta,
  savePollRound,
  saveRoundWithoutPoll,
  updateAnnouncedRoundMeta,
  type Round,
  type RoundMeta,
} from "../db/rounds.js";
import type { HandlerDeps } from "../handlers/deps.js";
import { handlePlayerDeleted } from "../handlers/closure.js";
import { MastodonApiError } from "../mastodon/client.js";
import { dm } from "../mastodon/dm.js";
import {
  postRound,
  postRoundResolution,
  postFinale,
  type PostRoundResult,
  type TallyInput,
} from "../mastodon/posts.js";
import {
  eligibleForRound,
  hasRoundCollision,
  type Game,
  type Player,
  type PotSplit,
  type Tune,
} from "../game/types.js";
import { champions, potShares } from "../game/scoring.js";
import { mulberry32, roundSeed, seededShuffle } from "../game/shuffle.js";
import { errorMessage } from "../errors.js";
import { addSeconds, SECONDS_PER_MINUTE } from "../time.js";
import { m } from "../i18n/index.js";
import { claimKey, exclusively } from "./claims.js";

/**
 * Round + finale emission — the single owner of the post-round lifecycle.
 * Both the command handlers (tune replacement, first round) and the
 * scheduler (poll resolution, resume sweeps) route through these functions,
 * so there is exactly one implementation of each transition's side effects.
 */

/** A tie carries the pot over to the next round, one point bigger (PRD §5.6). */
const TIE_POT_INCREMENT = 1;

/** HTTP statuses of a DM to an account that is gone or refuses the bot: its player leaves. */
const UNREACHABLE_ACCOUNT_STATUSES = [403, 404, 410];

/** A live round about to be emitted: its game, and who plays it with which tune. */
type LiveRound = {
  game: Game;
  round: number;
  players: Player[];
  /** Account IDs playing this round, in player order. */
  eligible: string[];
  /** Their tunes for this round, in the same order. */
  roundTunes: Tune[];
};

/** A round decided without a poll: what to persist, and the result to post. */
type DecidedRound = {
  status: "walkover" | "auto_tied";
  winnerAccountId: string | null;
  awards: [accountId: string, points: number][];
  potAfter: number;
  meta: RoundMeta;
  result: TallyInput;
};

/**
 * After `round` resolved (poll, auto-tie or walkover): emit the next round or
 * the finale. Idempotent, so recovery sweeps can call it again.
 */
export async function advanceAfterRound(handler: HandlerDeps, gameId: string, round: number): Promise<void> {
  const game = loadOpenGame(handler.db, gameId);
  if (!game) return;
  if (round >= game.playlistLength) {
    await enterFinale(handler, game);
    return;
  }
  if (!reachNextRound(handler, game, round)) return;
  await emitRound(handler, gameId, round + 1);
}

/** Put the game on the round after `round`. False when it is on neither (another sweep moved it on). */
function reachNextRound(handler: HandlerDeps, game: Game, round: number): boolean {
  if (game.currentRound === round) return advanceCurrentRound(handler.db, game.id, round, handler.now());
  return game.currentRound === round + 1;
}

/** Final round resolved → move the game to FINALE, post the finale thread, mark it CLOSED. */
async function enterFinale(handler: HandlerDeps, game: Game): Promise<void> {
  if (game.status !== "FINALE" && !moveToFinale(handler, game)) return;
  await emitFinale(handler, game.id);
}

/** ROUND/READY → FINALE. False from any other status, or when another sweep moved the game first. */
function moveToFinale(handler: HandlerDeps, game: Game): boolean {
  const canEnterFinale = game.status === "ROUND" || game.status === "READY";
  return canEnterFinale && setGameStatus(handler.db, game.id, game.status, "FINALE", handler.now());
}

/** Post round thread + poll (or auto-tie/walkover) for the given round. Persists rounds row. */
export async function emitRound(handler: HandlerDeps, gameId: string, round: number): Promise<void> {
  await exclusively(claimKey.round(gameId, round), () => emitClaimedRound(handler, gameId, round));
}

async function emitClaimedRound(handler: HandlerDeps, gameId: string, round: number): Promise<void> {
  if (!isLiveRound(handler.db, gameId, round)) return;
  const excluded = await playersToExclude(handler, gameId, round);
  if (!excluded) return;
  const live = loadLiveRound(handler.db, gameId, round, excluded);
  if (!live) return;

  if (live.eligible.length <= 1) {
    await resolveWithoutPoll(handler, live, decideWalkover(live));
  } else if (hasRoundCollision(live.roundTunes, round)) {
    await resolveWithoutPoll(handler, live, decideAutoTie(live));
  } else {
    await publishRoundPoll(handler, live);
  }
}

/**
 * v1.1 1.4 availability gate. Returns the players to exclude from the round,
 * or null when it must not be published: its replacement window is still
 * open, or the window closed the game.
 */
async function playersToExclude(handler: HandlerDeps, gameId: string, round: number): Promise<Set<string> | null> {
  const players = loadPlayers(handler.db, gameId);
  const tunes = loadTunes(handler.db, gameId);
  const eligibleIds = eligibleForRound(players, tunes, round);
  if (eligibleIds.length === 0) return new Set();

  const outcome = await ensureAvailability(handler, {
    gameId,
    round,
    eligibleIds,
    tunes: new Map(tunes.filter((t) => t.position === round).map((t): [string, Tune] => [t.accountId, t])),
  });
  if (outcome.kind === "ready") return outcome.excluded;
  // Aborted means the game went terminal (unreachable player → FORFEIT) —
  // never publish a round thread onto a void game.
  if (outcome.kind === "aborted") deleteAnnouncedRound(handler.db, gameId, round);
  return null;
}

/** The round as it stands now, or null when the game is no longer on it. */
function loadLiveRound(db: Db, gameId: string, round: number, excluded: Set<string>): LiveRound | null {
  const game = loadGame(db, gameId);
  if (game?.status !== "ROUND" || game.currentRound !== round) return null;
  const players = loadPlayers(db, gameId);
  const tunes = loadTunes(db, gameId);
  const eligible = eligibleForRound(players, tunes, round, excluded);
  const roundTunes = tunes
    .filter((t) => t.position === round && eligible.includes(t.accountId))
    .sort((a, b) => eligible.indexOf(a.accountId) - eligible.indexOf(b.accountId));
  return { game, round, players, eligible, roundTunes };
}

/** Walkover: only one player remains in this round (PRD §7 / v1.1 1.4). */
function decideWalkover({ game, round, players, eligible }: LiveRound): DecidedRound {
  const winner = eligible[0] ?? null;
  const potAfter = winner ? 0 : game.pot;
  return {
    status: "walkover",
    winnerAccountId: winner,
    awards: winner ? [[winner, game.pot]] : [],
    potAfter,
    meta: { participants: eligible },
    result: {
      round,
      winnerAcct: winner ? players.find((p) => p.accountId === winner)?.acct ?? winner : null,
      potAwarded: game.pot,
      wasTie: false,
      walkover: true,
      newPot: potAfter,
    },
  };
}

/** Auto-tie: identical video across players → no poll (PRD §5.6). */
function decideAutoTie(live: LiveRound): DecidedRound {
  if (live.round >= live.game.playlistLength) return decideFinalAutoTie(live);
  const potAfter = live.game.pot + TIE_POT_INCREMENT;
  return {
    status: "auto_tied",
    winnerAccountId: null,
    awards: [],
    potAfter,
    meta: { participants: live.eligible },
    result: { round: live.round, winnerAcct: null, potAwarded: 0, wasTie: true, newPot: potAfter },
  };
}

/**
 * v1.1 1.3: final-round auto-tie splits the pre-round pot among all round
 * participants (no poll ran, so everyone is "tied").
 */
function decideFinalAutoTie({ game, round, eligible }: LiveRound): DecidedRound {
  const split = potShares(game.pot, eligible.length);
  return {
    status: "auto_tied",
    winnerAccountId: null,
    awards: split ? eligible.map((id) => [id, split.each]) : [],
    potAfter: 0,
    meta: split ? { finalSplit: split, participants: eligible } : { participants: eligible },
    result: { round, winnerAcct: null, potAwarded: 0, wasTie: true, newPot: 0, potSplit: split },
  };
}

/** Persist a round decided without a poll (walkover / auto-tie), post its result, move on. */
async function resolveWithoutPoll(handler: HandlerDeps, live: LiveRound, decided: DecidedRound): Promise<void> {
  const gameId = live.game.id;
  if (!commitDecidedRound(handler.db, gameId, live.round, decided)) return;
  if (!await postRoundResult(handler, gameId, live.round, decided.result)) return;
  await advanceAfterRound(handler, gameId, live.round);
}

/** Atomically record the round, its awards and the new pot. False when the round is no longer live. */
function commitDecidedRound(db: Db, gameId: string, round: number, decided: DecidedRound): boolean {
  return db.transaction(() => {
    if (!isLiveRound(db, gameId, round)) return false;
    saveRoundWithoutPoll(db, gameId, round, {
      status: decided.status,
      winnerAccountId: decided.winnerAccountId,
      meta: decided.meta,
      resolutionJson: JSON.stringify(decided.result),
    });
    for (const [accountId, points] of decided.awards) awardPoints(db, gameId, accountId, points);
    setGamePot(db, gameId, decided.potAfter);
    return true;
  })();
}

/** Post the round thread and its poll, then record the poll on the round. */
async function publishRoundPoll(handler: HandlerDeps, live: LiveRound): Promise<void> {
  const { game, round } = live;
  // v1.1 1.7: deterministic shuffle of poll option / announce order.
  const postOrder = seededShuffle(live.roundTunes, mulberry32(roundSeed(game.id, round)));
  openAnnouncedRound(handler.db, game.id, round, { publishing: true });

  const poll = await postRound(handler.client, game, live.players, postOrder, round);
  if (!savePostedPoll(handler.db, game.id, round, poll)) await deleteOrphanedPoll(handler, poll.pollStatusId);
}

/**
 * Move the announced round to poll_open; a poll whose game moved on while it
 * was posting is flagged for cleanup. False when the round is no longer
 * announced.
 */
function savePostedPoll(db: Db, gameId: string, round: number, poll: PostRoundResult): boolean {
  return db.transaction(() => {
    if (loadRound(db, gameId, round)?.status !== "announced") return false;
    const gameMovedOn = !isLiveRound(db, gameId, round);
    return savePollRound(db, gameId, round, poll, gameMovedOn);
  })();
}

/**
 * Orphaned poll: nothing references it any more. Silent best effort — no
 * sweep retries it, so removeStatus's "will retry" warning would mislead.
 */
async function deleteOrphanedPoll(handler: HandlerDeps, pollStatusId: string): Promise<void> {
  try {
    await handler.client.delete(`/api/v1/statuses/${pollStatusId}`);
  } catch {
    // Best effort only.
  }
}

/** Post a decided round's result and stamp it posted. False when the game went terminal first. */
export async function postRoundResult(
  handler: HandlerDeps,
  gameId: string,
  round: number,
  result: TallyInput,
): Promise<boolean> {
  const game = loadOpenGame(handler.db, gameId);
  if (!game) return false;
  await postRoundResolution(handler.client, game, loadPlayers(handler.db, gameId), result);
  markResolutionPosted(handler.db, gameId, round, handler.now());
  return true;
}

/** Post a persisted-but-unposted round result. False when the game went terminal first. */
export async function recoverRoundResult(
  handler: HandlerDeps,
  gameId: string,
  round: number,
): Promise<boolean> {
  const persisted = loadRound(handler.db, gameId, round);
  if (!awaitsResultPost(persisted)) return true;
  if (!loadOpenGame(handler.db, gameId)) return false;
  const result = parseRoundResult(persisted.resolutionJson);
  if (!result) return true;
  return postRoundResult(handler, gameId, round, result);
}

/** A decided round whose result has not been posted yet. */
function awaitsResultPost(round: Round | undefined): round is Round {
  return round !== undefined && !round.resolutionPostedAt && RESOLVED_ROUND_STATUSES.includes(round.status);
}

/** The persisted round result; null when missing or malformed. */
function parseRoundResult(resolutionJson: string | null): TallyInput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resolutionJson ?? "null");
  } catch {
    return null;
  }
  return parsed && typeof parsed === "object" ? parsed as TallyInput : null;
}

/** recoverRoundResult for rounds 1..throughRound, stopping at the first failure. */
export async function recoverRoundResults(
  handler: HandlerDeps,
  gameId: string,
  throughRound: number,
): Promise<boolean> {
  for (let round = 1; round <= throughRound; round += 1) {
    if (!await recoverRoundResult(handler, gameId, round)) return false;
  }
  return true;
}

type AvailabilityOutcome =
  | { kind: "ready"; excluded: Set<string> }
  | { kind: "waiting" }
  /** The window closed the game (deleted/unreachable player): publish nothing. */
  | { kind: "aborted" };

/** A round awaiting its availability check: who plays it, and each one's tune for it. */
type RoundCandidates = {
  gameId: string;
  round: number;
  eligibleIds: string[];
  /** The caller's snapshot: nothing writes tunes while the check runs. */
  tunes: Map<string, Tune>;
};

/** Replacement-window state (v1.1 1.4), persisted as the announced round's `replacement` meta. */
type ReplacementWindow = {
  deadline: string;
  notified: Set<string>;
  /** Account ID → status ID of the DM asking for a replacement. */
  prompts: Record<string, string>;
};

/**
 * v1.1 1.4: ensure every eligible player's tune for this round is available.
 *
 * - All available → ready (excluded empty).
 * - Some unavailable, no announced row yet → create 'announced' row, DM each
 *   affected player, return waiting (deadline = now + REPLACEMENT_GRACE_MIN).
 * - Window still open → re-check; DM newly-notified; if all healthy now, publish
 *   early (ready).
 * - At/after deadline → re-check; still-dead players are excluded (round forfeit).
 */
async function ensureAvailability(handler: HandlerDeps, candidates: RoundCandidates): Promise<AvailabilityOutcome> {
  const dead = await unavailablePlayers(handler, candidates);
  // All healthy (replacement arrived or false alarm) → publish now.
  if (dead.length === 0) return readyToPublish(handler.db, candidates);

  const existing = loadRound(handler.db, candidates.gameId, candidates.round);
  const announced = existing?.status === "announced" ? existing : undefined;
  const window = replacementWindow(handler, announced);
  // Window closed — exclude still-dead players (round forfeit only).
  if (!window) return readyToPublish(handler.db, candidates, new Set(dead));

  const allReachable = await promptReplacements(handler, candidates, dead, window);
  if (!allReachable) return { kind: "aborted" };
  const meta: RoundMeta = {
    replacement: { deadline: window.deadline, notified: [...window.notified], prompts: window.prompts },
  };
  return announced
    ? await recheckOpenWindow(handler, candidates, meta)
    : openReplacementWindow(handler.db, candidates, meta);
}

/** Eligible players whose round tune is no longer available, checked live one by one. */
async function unavailablePlayers(handler: HandlerDeps, candidates: RoundCandidates): Promise<string[]> {
  const dead: string[] = [];
  for (const accountId of candidates.eligibleIds) {
    const tune = candidates.tunes.get(accountId);
    if (tune && !(await handler.checkAvailable(tune.videoId))) dead.push(accountId);
  }
  return dead;
}

/** Publish the round now, dropping its replacement window and excluding `excluded`. */
function readyToPublish(db: Db, candidates: RoundCandidates, excluded = new Set<string>()): AvailabilityOutcome {
  deleteAnnouncedRound(db, candidates.gameId, candidates.round);
  return { kind: "ready", excluded };
}

/**
 * The replacement window's state: resumed from the announced round, or a new
 * window closing REPLACEMENT_GRACE_MIN from now. Null once a resumed window's
 * deadline has passed.
 */
function replacementWindow(handler: HandlerDeps, announced: Round | undefined): ReplacementWindow | null {
  const now = handler.now();
  if (!announced) {
    const deadline = addSeconds(now, handler.replacementGraceMin * SECONDS_PER_MINUTE).toISOString();
    return { deadline, notified: new Set(), prompts: {} };
  }
  const saved = roundMeta(announced).replacement ?? {};
  const deadline = saved.deadline;
  if (!deadline || now.getTime() >= new Date(deadline).getTime()) return null;
  return { deadline, notified: new Set(saved.notified ?? []), prompts: { ...(saved.prompts ?? {}) } };
}

/**
 * DM each unavailable player not yet prompted, recording the prompt in the
 * window. False when a player is unreachable: that closes the game.
 */
async function promptReplacements(
  handler: HandlerDeps,
  candidates: RoundCandidates,
  dead: string[],
  window: ReplacementWindow,
): Promise<boolean> {
  const { round } = candidates;
  for (const accountId of dead) {
    if (window.notified.has(accountId)) continue;
    const tune = candidates.tunes.get(accountId)!;
    try {
      const prompt = m().replaceTuneDm(tune.position, round, tune.title, window.deadline);
      window.prompts[accountId] = await dm(handler, accountId, prompt);
      window.notified.add(accountId);
    } catch (err) {
      if (err instanceof MastodonApiError && UNREACHABLE_ACCOUNT_STATUSES.includes(err.status)) {
        await handlePlayerDeleted(handler, accountId);
        return false;
      }
      handler.logger?.warn({ accountId, round, err: errorMessage(err) }, "replacement DM failed; retrying later");
    }
  }
  return true;
}

/** Open the window as the round's announced row. Aborted when the round is no longer live. */
function openReplacementWindow(db: Db, candidates: RoundCandidates, meta: RoundMeta): AvailabilityOutcome {
  if (!isLiveRound(db, candidates.gameId, candidates.round)) return { kind: "aborted" };
  openAnnouncedRound(db, candidates.gameId, candidates.round, meta);
  return { kind: "waiting" };
}

/** Save the resumed window; if everything is healthy now (replacements arrived), publish. */
async function recheckOpenWindow(
  handler: HandlerDeps,
  candidates: RoundCandidates,
  meta: RoundMeta,
): Promise<AvailabilityOutcome> {
  updateAnnouncedRoundMeta(handler.db, candidates.gameId, candidates.round, meta);
  const stillDead = await unavailablePlayers(handler, candidates);
  return stillDead.length === 0 ? readyToPublish(handler.db, candidates) : { kind: "waiting" };
}

/** Load round winners and post the finale thread, then close the game (PRD §5.7). */
export async function emitFinale(handler: HandlerDeps, gameId: string): Promise<void> {
  await exclusively(claimKey.finale(gameId), () => emitClaimedFinale(handler, gameId));
}

/** A round winner's tune, tagged with its round. */
type WinningTune = Tune & { round: number };

async function emitClaimedFinale(handler: HandlerDeps, gameId: string): Promise<void> {
  const db = handler.db;
  const game = loadGame(db, gameId);
  if (game?.status !== "FINALE") return;
  if (!await recoverRoundResults(handler, gameId, game.playlistLength)) return;
  const players = loadPlayers(db, gameId);
  const tunes = loadTunes(db, gameId);
  const winningTunes = roundWinningTunes(db, gameId, tunes);
  const duelRounds = loadRounds(db, gameId).filter((r) => r.number <= game.playlistLength);
  const duelers = duelParticipants(players, duelRounds, tunes);
  const potSplit = settleFinalPot(db, game, duelRounds.find((r) => r.number === game.playlistLength));
  // One link to the whole battle: a saved YT Music playlist when the bot
  // account is configured, an anonymous YouTube queue otherwise. Best-effort —
  // the finale posts its standings and per-round winners either way.
  const queueUrl = loadFinaleQueueUrl(db, gameId) ?? await publishBattleLink(handler, game, winningTunes);

  await postFinale(handler.client, game, duelers, champions(duelers), winningTunes, {
    duelThreadId: game.threadRootId,
    potSplit,
    queueUrl,
  });

  setGameStatus(db, gameId, "FINALE", "CLOSED", handler.now());
}

function roundWinningTunes(db: Db, gameId: string, tunes: Tune[]): WinningTune[] {
  return loadRoundWinners(db, gameId).flatMap(({ round, winnerAccountId }) => {
    const tune = tunes.find((t) => t.accountId === winnerAccountId && t.position === round);
    return tune ? [{ ...tune, round }] : [];
  });
}

/** Accepted players who played the duel — every accepted player when no round records who played it. */
function duelParticipants(players: Player[], duelRounds: Round[], tunes: Tune[]): Player[] {
  const participated = new Set(duelRounds.flatMap((round) => roundParticipants(round, tunes)));
  const nobodyRecorded = participated.size === 0;
  return players.filter(
    (p) => p.inviteStatus === "accepted" && (nobodyRecorded || participated.has(p.accountId)),
  );
}

/** Who played a round: its recorded participants, else its poll's option accounts, else whoever had a tune in it. */
function roundParticipants(round: Round, tunes: Tune[]): string[] {
  const { participants } = roundMeta(round);
  if (Array.isArray(participants)) return participants;
  const pollAccounts = pollOptionAccounts(round);
  if (pollAccounts.length > 0) return pollAccounts;
  return tunes.filter((t) => t.position === round.number).map((t) => t.accountId);
}

/**
 * v1.1 1.3: a tied final round splits the pot (persisted as finalSplit meta).
 * Returns that split; null when the final round had a winner or split nothing.
 */
function settleFinalPot(db: Db, game: Game, finalRound: Round | undefined): PotSplit | null {
  const finalTied = !finalRound || finalRound.status === "auto_tied" || finalRound.winnerAccountId === null;
  if (!finalTied) return null;
  const recorded = roundMeta(finalRound).finalSplit;
  const split = recorded && recorded.total > 0
    ? { total: recorded.total, each: recorded.each, count: recorded.count }
    : null;
  // Walkover-final with null winner: leftover pot is silently zeroed.
  if (game.pot > 0) setGamePot(db, game.id, 0);
  return split;
}

/**
 * Publish the battle link, persisting it (and its YT Music playlist) the
 * moment it exists so a resumed finale posts the same one.
 */
async function publishBattleLink(
  handler: HandlerDeps,
  game: Game,
  winningTunes: WinningTune[],
): Promise<string | null> {
  const link = await handler.publishBattlePlaylist({
    theme: game.theme,
    rounds: game.playlistLength,
    tunes: winningTunes.map((t) => ({ round: t.round, videoId: t.videoId })),
    existingPlaylistId: game.battlePlaylistId,
  });
  const queueUrl = link?.url ?? null;
  if (queueUrl !== null) saveFinaleQueueUrl(handler.db, game.id, queueUrl);
  if (link?.playlistId && link.playlistId !== game.battlePlaylistId) {
    saveBattlePlaylistId(handler.db, game.id, link.playlistId);
  }
  return queueUrl;
}
