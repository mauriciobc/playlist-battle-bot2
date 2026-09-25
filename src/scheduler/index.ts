import { completeCreation, type HandlerDeps } from "../handlers/mention.js";
import { removeStatus } from "../handlers/closure.js";
import { NON_TERMINAL_STATUS_SQL } from "../db/index.js";
import { isTerminal, type GameStatus } from "../game/types.js";
import { m } from "../i18n/index.js";
import {
  markRoundResolved,
  setGameStatus,
  loadGame,
  loadPlayers,
  loadRound,
  loadTunes,
  RESOLVED_ROUND_STATUSES,
  saveGame,
  saveGameState,
} from "../game/store.js";
import {
  advanceAfterRound,
  emitRound,
  emitFinale,
  exclusively,
  isClaimed,
  postRoundResult,
  recoverRoundResult,
  recoverRoundResults,
} from "./roundState.js";
import { finalizeCollection, startRound, resolveRound } from "../game/engine.js";
import { tallyPoll, pollSnapshot, postSideEffect, type PollSnapshot, type TallyInput } from "../mastodon/posts.js";

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

type Tallies = { accountId: string; votes: number }[];

/**
 * Sweep acceptance + submission windows (PRD §5.2, §5.4, §7).
 */
export async function checkDeadlines(deps: SchedulerDeps): Promise<void> {
  const { handler } = deps;
  const now = handler.now();
  const nowIso = now.toISOString();
  const db = handler.db;

  // 1. Acceptance window: INVITED games past deadline with zero accepts → EXPIRED
  const expired = db
    .prepare(
      `SELECT id FROM games g
       WHERE status = 'INVITED' AND acceptance_deadline IS NOT NULL AND acceptance_deadline <= ?
         AND NOT EXISTS (SELECT 1 FROM players p WHERE p.game_id = g.id
                         AND p.role = 'challenger' AND p.invite_status = 'accepted')`,
    )
    .all(nowIso) as { id: string }[];
  for (const { id } of expired) {
    setGameStatus(db, id, "INVITED", "EXPIRED", now);
    const game = loadGame(db, id);
    if (game) await postSideEffect(handler.client, game, "expired");
  }

  // 2. Acceptance window closed with some accepts → expire remaining pending challengers
  const pendingExpiry = db
    .prepare(
      `UPDATE players SET invite_status = 'expired'
       WHERE invite_status = 'pending' AND game_id IN (
         SELECT id FROM games WHERE status IN ('INVITED','COLLECTING')
           AND acceptance_deadline IS NOT NULL AND acceptance_deadline <= ?)`,
    )
    .run(nowIso).changes;

  // 3. Submission window: COLLECTING past deadline → finalize
  const collecting = db
    .prepare(
      `SELECT id FROM games WHERE status = 'COLLECTING' AND submission_deadline IS NOT NULL AND submission_deadline <= ?`,
    )
    .all(nowIso) as { id: string }[];
  for (const { id } of collecting) {
    await finalizeCollecting(handler, id);
  }

  // 4. v1.1 1.4: announced rounds past their replacement deadline → re-enter
  // emitRound (availability re-check → publish / exclude / walkover).
  const announced = db
    .prepare(
      `SELECT r.game_id, r.number FROM rounds r
       JOIN games g ON g.id = r.game_id
       WHERE r.status = 'announced' AND g.status ${NON_TERMINAL_STATUS_SQL}`,
    )
    .all() as { game_id: string; number: number }[];
  for (const row of announced) {
    await emitRound(handler, row.game_id, row.number);
  }

  handler.logger?.debug(
    {
      expiredGames: expired.length,
      expiredPendingInvites: pendingExpiry,
      finalizedGames: collecting.length,
      reemittedRounds: announced.length,
    },
    "deadline sweep complete",
  );
}

async function finalizeCollecting(handler: HandlerDeps, gameId: string): Promise<void> {
  const db = handler.db;
  const game = loadGame(db, gameId)!;
  const now = handler.now();
  const result = finalizeCollection(game, loadPlayers(db, gameId), loadTunes(db, gameId), game.playlistLength, now);
  if (!saveGameState(db, result.game, result.players, "COLLECTING")) return;

  if (result.outcome === "fizzled") {
    await postSideEffect(handler.client, result.game, "fizzled");
    return;
  }
  if (result.outcome === "default_win") {
    const winner = result.players.find((p) => p.accountId === result.defaultWinnerId);
    await postSideEffect(handler.client, result.game, "default_win", winner?.acct);
    // proceed to finale immediately (posts summary + closes)
    setGameStatus(db, gameId, "COLLECTING", "FINALE", now);
    await emitFinale(handler, gameId);
    return;
  }

  // ready → start round 1
  saveGame(db, startRound(result.game, 1, now));
  await emitRound(handler, gameId, 1);
}

/**
 * Retry poll deletion for rounds that must stop collecting votes: open polls
 * of terminal games, and polls flagged cleanup-pending. Returns the rounds of
 * still-open games whose poll was cleaned up here.
 */
async function retryTerminalPollCleanup(handler: HandlerDeps): Promise<{ gameId: string; round: number }[]> {
  const cleaned: { gameId: string; round: number }[] = [];
  const rows = handler.db
    .prepare(
      `SELECT r.game_id, r.number, r.status AS round_status, r.poll_status_id, g.status AS game_status
       FROM rounds r JOIN games g ON g.id = r.game_id
       WHERE r.status = 'poll_open' OR r.poll_cleanup_pending = 1`,
    )
    .all() as {
    game_id: string;
    number: number;
    round_status: string;
    poll_status_id: string | null;
    game_status: GameStatus;
  }[];

  for (const row of rows) {
    if (row.round_status === "poll_open" && !isTerminal(row.game_status)) continue;
    if (row.round_status === "announced" && !row.poll_status_id) continue;
    if (
      row.poll_status_id &&
      !(await removeStatus(handler, row.poll_status_id, { gameId: row.game_id, round: row.number }))
    ) {
      continue;
    }
    const updated = handler.db
      .prepare(
        `UPDATE rounds SET status = 'resolved', poll_cleanup_pending = 0,
           poll_status_id = NULL, poll_id = NULL, poll_expires_at = NULL
         WHERE game_id = ? AND number = ? AND (status = 'poll_open' OR poll_cleanup_pending = 1)`,
      )
      .run(row.game_id, row.number);
    if (updated.changes === 1 && !isTerminal(row.game_status)) {
      cleaned.push({ gameId: row.game_id, round: row.number });
    }
  }
  return cleaned;
}

/**
 * Sweep open polls past expires_at → tally → resolve → next round or finale (PRD §5.5/§5.6).
 * Also consumes poll-expired notifications via checkPollNotification,
 * and (when earlyClose is enabled) resolves stagnant polls before expiry.
 */
export async function checkPolls(deps: SchedulerDeps): Promise<void> {
  const { handler } = deps;
  const db = handler.db;
  const cleanedRounds = await retryTerminalPollCleanup(handler);
  for (const cleaned of cleanedRounds) {
    if (!await recoverRoundResult(handler, cleaned.gameId, cleaned.round)) continue;
    await advanceAfterRound(handler, cleaned.gameId, cleaned.round);
  }

  const due = db
    .prepare(
      `SELECT r.game_id, r.number, r.poll_id, r.option_map_json
       FROM rounds r JOIN games g ON g.id = r.game_id
       WHERE r.status = 'poll_open' AND r.poll_expires_at IS NOT NULL AND r.poll_expires_at <= ?
         AND g.status ${NON_TERMINAL_STATUS_SQL}`,
    )
    .all(handler.now().toISOString()) as {
    game_id: string;
    number: number;
    poll_id: string;
    option_map_json: string;
  }[];

  for (const row of due) {
    await resolvePollRow(handler, row.game_id, row.number, row.poll_id, row.option_map_json);
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
 * Resolve still-open polls whose vote totals stopped changing (Mastodon has no
 * early-close API — we tally live counts, resolve bot-side, then delete the
 * poll status so late votes can't land on a decided round).
 *
 * Guardrails: poll must be older than minAgeSec, votes unchanged for
 * stagnationSec, and tallies must be visible (hide_totals off).
 */
async function checkStagnantPolls(handler: HandlerDeps, ec: EarlyCloseConfig): Promise<void> {
  const db = handler.db;
  const now = handler.now();

  const open = db
    .prepare(
      `SELECT r.game_id, r.number, r.poll_id, r.poll_status_id, r.option_map_json,
              r.poll_expires_at, r.watched_votes, r.watched_tally_json, r.votes_changed_at, g.poll_duration_sec
       FROM rounds r JOIN games g ON g.id = r.game_id
       WHERE r.status = 'poll_open' AND r.poll_expires_at IS NOT NULL AND r.poll_expires_at > ?
         AND g.status ${NON_TERMINAL_STATUS_SQL}`,
    )
    .all(now.toISOString()) as {
    game_id: string;
    number: number;
    poll_id: string;
    poll_status_id: string;
    option_map_json: string;
    poll_expires_at: string;
    watched_votes: number | null;
    watched_tally_json: string | null;
    votes_changed_at: string | null;
    poll_duration_sec: number;
  }[];

  for (const row of open) {
    if (isClaimed(`poll:${row.game_id}#${row.number}`)) continue;

    let snapshot: PollSnapshot | null;
    try {
      snapshot = await pollSnapshot(handler.client, row.poll_id, JSON.parse(row.option_map_json));
    } catch {
      continue; // transient API error — natural expiry still resolves this poll
    }
    if (!snapshot) continue; // hidden tallies — cannot make a trustworthy early call

    const expiresAt = new Date(row.poll_expires_at);
    const openedAt = new Date(expiresAt.getTime() - row.poll_duration_sec * 1000);
    const fingerprint = JSON.stringify(
      [...snapshot.tallies].sort((a, b) => a.accountId.localeCompare(b.accountId)),
    );
    const watch = (changedAt: Date): void => {
      db.prepare(
        `UPDATE rounds SET watched_votes = ?, watched_tally_json = ?, votes_changed_at = ?
         WHERE game_id = ? AND number = ? AND status = 'poll_open' AND poll_id = ?`,
      ).run(snapshot.totalVotes, fingerprint, changedAt.toISOString(), row.game_id, row.number, row.poll_id);
    };

    // Legacy rows tracked only the vote total, not the per-option tally.
    const unchanged = row.watched_tally_json === null
      ? row.watched_votes === snapshot.totalVotes
      : row.watched_tally_json === fingerprint;
    let changedAt = new Date(row.votes_changed_at ?? openedAt.toISOString());
    if (row.watched_tally_json === null && row.watched_votes === null) {
      changedAt = snapshot.totalVotes === 0 ? openedAt : now; // first sight
      watch(changedAt);
    } else if (!unchanged) {
      watch(now);
      continue;
    } else if (row.watched_tally_json === null) {
      watch(changedAt); // adopt the fingerprint for a legacy row
    }

    const ageSec = (now.getTime() - openedAt.getTime()) / 1000;
    const stillSec = (now.getTime() - changedAt.getTime()) / 1000;
    if (ageSec < ec.minAgeSec || stillSec < ec.stagnationSec) continue;
    if (expiresAt.getTime() <= now.getTime()) continue; // due sweep owns it

    await resolvePollRow(handler, row.game_id, row.number, row.poll_id, row.option_map_json, {
      tallies: snapshot.tallies,
      removePoll: async () => {
        const context = { gameId: row.game_id, round: row.number };
        if (!(await removeStatus(handler, row.poll_status_id, context))) return false;
        db.prepare(
          `UPDATE rounds SET poll_cleanup_pending = 0, poll_status_id = NULL, poll_id = NULL, poll_expires_at = NULL
           WHERE game_id = ? AND number = ? AND poll_id = ?`,
        ).run(row.game_id, row.number, row.poll_id);
        return true;
      },
    });
  }
}

/** Entry point for `type=poll` notifications (fast path) — resolves immediately if due. */
export async function checkPollNotification(
  deps: SchedulerDeps,
  statusId: string | null,
): Promise<boolean> {
  if (!statusId) return false;
  const { handler } = deps;
  const row = handler.db
    .prepare(
      `SELECT game_id, number, poll_id, option_map_json, poll_expires_at
       FROM rounds WHERE poll_status_id = ? AND status = 'poll_open'`,
    )
    .get(statusId) as
    | {
        game_id: string;
        number: number;
        poll_id: string;
        option_map_json: string;
        poll_expires_at: string | null;
      }
    | undefined;
  if (!row?.poll_expires_at || new Date(row.poll_expires_at).getTime() > handler.now().getTime()) {
    return false;
  }
  await resolvePollRow(handler, row.game_id, row.number, row.poll_id, row.option_map_json);
  return true;
}

/**
 * Tally and resolve one open poll. `early` (stagnation close) supplies live
 * tallies and removes the still-open poll status before the result posts.
 */
async function resolvePollRow(
  handler: HandlerDeps,
  gameId: string,
  roundNumber: number,
  pollId: string,
  optionMapJson: string,
  early?: { tallies: Tallies; removePoll: () => Promise<boolean> },
): Promise<void> {
  const db = handler.db;
  const liveGame = () => {
    const round = db
      .prepare("SELECT status, poll_id FROM rounds WHERE game_id = ? AND number = ?")
      .get(gameId, roundNumber) as { status: string; poll_id: string | null } | undefined;
    const game = loadGame(db, gameId);
    return round?.status === "poll_open" && round.poll_id === pollId &&
      game?.status === "ROUND" && game.currentRound === roundNumber
      ? game
      : null;
  };

  // The 60s sweep and the notification fast-path run on independent timers, so
  // both can race for the same poll: whoever fails to claim defers to the holder
  // (checkStagnantPolls tests the same key); the re-check under the claim skips
  // rows the holder already resolved.
  await exclusively(`poll:${gameId}#${roundNumber}`, async () => {
    if (!liveGame()) return;
    const tallies = early?.tallies ??
      (await tallyPoll(handler.client, pollId, JSON.parse(optionMapJson) as Record<string, string>));
    const game = liveGame();
    if (!game) return;

    const outcome = resolveRound({
      game,
      players: loadPlayers(db, gameId),
      tallies,
      roundNumber,
      now: handler.now(),
    });
    const winnerPlayer = outcome.players.find((p) => p.accountId === outcome.winnerAccountId);
    const resolutionInput: TallyInput = {
      round: roundNumber,
      winnerAcct: winnerPlayer?.acct ?? null,
      potAwarded: outcome.potAwarded,
      wasTie: outcome.winnerAccountId === null,
      newPot: outcome.game.pot,
      potSplit: outcome.finalSplit,
    };
    db.transaction(() => {
      if (!saveGameState(db, outcome.game, outcome.players, "ROUND")) {
        throw new Error(`Game ${gameId} changed state before round ${roundNumber} could be resolved`);
      }
      markRoundResolved(
        db,
        gameId,
        roundNumber,
        outcome.winnerAccountId,
        outcome.finalSplit ? { finalSplit: outcome.finalSplit } : {},
        early !== undefined,
        JSON.stringify(resolutionInput),
      );
    })();

    const persistedGame = loadGame(db, gameId);
    if (!persistedGame || isTerminal(persistedGame.status)) return;
    if (early && !(await early.removePoll())) return;
    if (!await postRoundResult(handler, gameId, roundNumber, resolutionInput)) return;
    await advanceAfterRound(handler, gameId, roundNumber);
  });
}

/**
 * CREATED games whose creation was interrupted: finish them, except a
 * private-visibility creation, which cannot host the public thread and is
 * cancelled with a private notice.
 */
async function resumeCreatedGames(handler: HandlerDeps): Promise<void> {
  const rows = handler.db
    .prepare(
      `SELECT id, theme, creation_status_id, creation_visibility
       FROM games WHERE status = 'CREATED' AND creation_status_id IS NOT NULL`,
    )
    .all() as { id: string; theme: string; creation_status_id: string; creation_visibility: string }[];

  for (const row of rows) {
    if (row.creation_visibility === "private") {
      if (!setGameStatus(handler.db, row.id, "CREATED", "CANCELLED", handler.now())) continue;
      try {
        await handler.client.post<{ id: string }>("/api/v1/statuses", {
          status: m().sideCancelled(row.theme),
          in_reply_to_id: row.creation_status_id,
          visibility: "private",
        }, { idempotencyKey: `pb:v1:creation:${row.creation_status_id}:private-cancel` });
      } catch (err) {
        handler.logger?.warn({ gameId: row.id, err }, "private creation cancellation notice failed");
      }
      continue;
    }
    try {
      await completeCreation(
        handler,
        row.id,
        row.creation_status_id,
        row.creation_visibility === "unlisted" ? "unlisted" : "public",
      );
    } catch (err) {
      handler.logger?.warn(
        { gameId: row.id, err: err instanceof Error ? err.message : String(err) },
        "created game recovery failed; will retry",
      );
    }
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
  const db = handler.db;

  await resumeCreatedGames(handler);
  await checkDeadlines(deps);
  await checkPolls(deps);

  // READY stuck: finished collection but never emitted round 1
  const readies = db.prepare(`SELECT id FROM games WHERE status = 'READY'`).all() as { id: string }[];
  for (const { id } of readies) {
    if (!saveGame(db, startRound(loadGame(db, id)!, 1, handler.now()), "READY")) continue;
    await emitRound(handler, id, 1);
  }

  const roundGames = db
    .prepare("SELECT id, current_round FROM games WHERE status = 'ROUND'")
    .all() as { id: string; current_round: number }[];
  for (const { id, current_round } of roundGames) {
    const round = current_round > 0 ? current_round : 1;
    if (!await recoverRoundResults(handler, id, round)) continue;
    const row = loadRound(db, id, round);
    if (!row) {
      await emitRound(handler, id, round);
    } else if (RESOLVED_ROUND_STATUSES.includes(row.status)) {
      await advanceAfterRound(handler, id, round);
    }
  }

  // FINALE stuck: never posted/closed
  const finales = db.prepare(`SELECT id FROM games WHERE status = 'FINALE'`).all() as { id: string }[];
  for (const { id } of finales) {
    await emitFinale(handler, id);
  }

  handler.logger?.debug(
    {
      readyStuck: readies.length,
      inFlightRounds: roundGames.length,
      stuckFinales: finales.length,
    },
    "game recovery sweep complete",
  );
}
