import type { HandlerDeps } from "../handlers/mention.js";
import { NON_TERMINAL_STATUS_SQL } from "../db/index.js";
import { isTerminal, type GameStatus } from "../game/types.js";
import { m } from "../i18n/index.js";
import { dm } from "../mastodon/dm.js";
import { assertPostLength } from "../templates/truncate.js";
import { MastodonApiError } from "../mastodon/client.js";
import {
  markRoundResolved,
  loadGame,
  loadPlayers,
  loadRound,
  loadTunes,
  saveGame,
  savePlayer,
} from "../game/store.js";
import {
  emitRound,
  emitFinale,
  advanceToFinaleIfFinal,
  postRoundResult,
  recoverRoundResult,
} from "./roundState.js";
import { finalizeCollection, startRound, resolveRound, type FinalSplit } from "../game/engine.js";
import {
  tallyPoll,
  pollSnapshot,
  postSideEffect,
  type PollSnapshot,
  type TallyInput,
} from "../mastodon/posts.js";

export type EarlyCloseConfig = {
  enabled: boolean;
  /** Minimum poll age before early close is allowed. */
  minAgeSec: number;
  /** Votes unchanged for this long → close early. */
  stagnationSec: number;
};

export type SchedulerDeps = {
  handler: HandlerDeps;
  now: () => Date;
  /** Absent or disabled → polls only resolve at natural expiry. */
  earlyClose?: EarlyCloseConfig;
};

/**
 * Sweep acceptance + submission windows (PRD §5.2, §5.4, §7).
 */
export async function checkDeadlines(deps: SchedulerDeps): Promise<void> {
  const { handler, now } = deps;
  const nowIso = now().toISOString();
  const db = handler.db;

  // 1. Acceptance window: INVITED games past deadline with zero accepts → EXPIRED
  const invited = db
    .prepare(
      `SELECT id FROM games WHERE status = 'INVITED' AND acceptance_deadline IS NOT NULL AND acceptance_deadline <= ?`,
    )
    .all(nowIso) as { id: string }[];

  let expiredGames = 0;
  for (const { id } of invited) {
    const acceptedChallengers = db
      .prepare(
        `SELECT COUNT(*) AS c FROM players WHERE game_id = ? AND role = 'challenger' AND invite_status = 'accepted'`,
      )
      .get(id) as { c: number } | undefined;

    if ((acceptedChallengers?.c ?? 0) === 0) {
      expiredGames += 1;
      db.prepare("UPDATE games SET status = 'EXPIRED', updated_at = ? WHERE id = ?").run(nowIso, id);
      const game = loadGame(db, id);
      if (game) await postSideEffect(handler.client, game, "expired");
    }
  }

  // 2. Acceptance window closed with some accepts → expire remaining pending challengers
  const pastAcceptance = db
    .prepare(
      `SELECT id FROM games WHERE status IN ('INVITED','COLLECTING') AND acceptance_deadline IS NOT NULL AND acceptance_deadline <= ?`,
    )
    .all(nowIso) as { id: string }[];

  for (const { id } of pastAcceptance) {
    db.prepare(
      `UPDATE players SET invite_status = 'expired' WHERE game_id = ? AND invite_status = 'pending'`,
    ).run(id);
  }

  // 3. Submission window: COLLECTING past deadline → finalize
  const collecting = db
    .prepare(
      `SELECT id FROM games WHERE status = 'COLLECTING' AND submission_deadline IS NOT NULL AND submission_deadline <= ?`,
    )
    .all(nowIso) as { id: string }[];

  let finalizedGames = 0;
  for (const { id } of collecting) {
    finalizedGames += 1;
    await finalizeCollecting(handler, id, now());
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

  let reemittedRounds = 0;
  for (const row of announced) {
    reemittedRounds += 1;
    await emitRound(handler, row.game_id, row.number);
  }

  handler.logger?.debug(
    {
      expiredGames,
      pendingChallengerExpiry: pastAcceptance.length,
      finalizedGames,
      reemittedRounds,
    },
    "deadline sweep complete",
  );
}

async function finalizeCollecting(handler: HandlerDeps, gameId: string, now: Date): Promise<void> {
  const db = handler.db;
  const game = loadGame(db, gameId)!;
  const players = loadPlayers(db, gameId);
  const tunes = loadTunes(db, gameId);

  const result = finalizeCollection(game, players, tunes, game.playlistLength, now);

  const persisted = db.transaction(() => {
    if (!saveGame(db, result.game, "COLLECTING")) return false;
    for (const p of result.players) savePlayer(db, gameId, p);
    return true;
  })();
  if (!persisted) return;

  if (result.outcome === "fizzled") {
    await postSideEffect(handler.client, result.game, "fizzled");
    return;
  }
  if (result.outcome === "default_win") {
    const winner = result.players.find((p) => p.accountId === result.defaultWinnerId);
    await postSideEffect(handler.client, result.game, "default_win", winner?.acct);
    // proceed to finale immediately (posts summary + closes)
    db.prepare("UPDATE games SET status = 'FINALE', updated_at = ? WHERE id = ?").run(
      now.toISOString(),
      gameId,
    );
    await emitFinale(handler, gameId);
    return;
  }

  // ready → start round 1
  const started = startRound(loadGame(db, gameId)!, 1, now);
  saveGame(db, started);
  await emitRound(handler, gameId, 1);
}

async function retryTerminalPollCleanup(
  deps: SchedulerDeps,
): Promise<{ gameId: string; round: number }[]> {
  const { handler } = deps;
  const cleaned: { gameId: string; round: number }[] = [];
  const rows = handler.db
    .prepare(
      `SELECT r.game_id, r.number, r.status AS round_status, r.poll_status_id, r.poll_id,
              r.poll_cleanup_pending, g.status AS game_status
       FROM rounds r JOIN games g ON g.id = r.game_id
       WHERE r.status = 'poll_open' OR r.poll_cleanup_pending = 1`,
    )
    .all() as {
    game_id: string;
    number: number;
    round_status: string;
    poll_status_id: string | null;
    poll_id: string | null;
    poll_cleanup_pending: number;
    game_status: GameStatus;
  }[];

  for (const row of rows) {
    if (row.round_status === "poll_open" && !isTerminal(row.game_status)) continue;
    if (row.round_status === "announced" && !row.poll_status_id) continue;
    if (row.round_status !== "poll_open" && !row.poll_cleanup_pending) continue;
    if (row.poll_status_id) {
      try {
        await handler.client.delete(`/api/v1/statuses/${row.poll_status_id}`);
      } catch (err) {
        if (!(err instanceof MastodonApiError && (err.status === 404 || err.status === 410))) {
          handler.log?.("terminal poll cleanup failed; will retry", {
            gameId: row.game_id,
            round: row.number,
            pollStatusId: row.poll_status_id,
            err,
          });
          continue;
        }
      }
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
  const { handler, now } = deps;
  const nowDate = now();
  const nowIso = nowDate.toISOString();
  const db = handler.db;
  const cleanedRounds = await retryTerminalPollCleanup(deps);
  for (const cleaned of cleanedRounds) {
    if (!await recoverRoundResult(handler, cleaned.gameId, cleaned.round)) continue;
    await continueRecoveredRound(handler, cleaned.gameId, cleaned.round, nowDate);
  }

  const due = db
    .prepare(
      `SELECT r.game_id, r.number, r.poll_id, r.option_map_json, r.poll_status_id
       FROM rounds r JOIN games g ON g.id = r.game_id
       WHERE r.status = 'poll_open' AND r.poll_expires_at IS NOT NULL AND r.poll_expires_at <= ?
         AND g.status ${NON_TERMINAL_STATUS_SQL}`,
    )
    .all(nowIso) as {
    game_id: string;
    number: number;
    poll_id: string;
    option_map_json: string;
    poll_status_id: string;
  }[];

  for (const row of due) {
    await resolvePollRow(handler, row.game_id, row.number, row.poll_id, row.option_map_json, nowDate);
  }

  if (deps.earlyClose?.enabled) {
    await checkStagnantPolls(deps, deps.earlyClose, nowDate);
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
function tallyFingerprint(tallies: { accountId: string; votes: number }[]): string {
  return JSON.stringify(
    [...tallies].sort((a, b) => a.accountId.localeCompare(b.accountId)),
  );
}

async function checkStagnantPolls(
  deps: SchedulerDeps,
  ec: EarlyCloseConfig,
  now: Date,
): Promise<void> {
  const { handler } = deps;
  const db = handler.db;
  const nowIso = now.toISOString();

  const open = db
    .prepare(
      `SELECT r.game_id, r.number, r.poll_id, r.poll_status_id, r.option_map_json,
              r.poll_expires_at, r.watched_votes, r.watched_tally_json, r.votes_changed_at, g.poll_duration_sec
       FROM rounds r JOIN games g ON g.id = r.game_id
       WHERE r.status = 'poll_open' AND r.poll_expires_at IS NOT NULL AND r.poll_expires_at > ?
         AND g.status ${NON_TERMINAL_STATUS_SQL}`,
    )
    .all(nowIso) as {
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
    const key = `${row.game_id}#${row.number}`;
    if (resolvingPolls.has(key)) continue;

    let snapshot: PollSnapshot | null;
    try {
      snapshot = await pollSnapshot(handler.client, row.poll_id, JSON.parse(row.option_map_json));
    } catch {
      continue; // transient API error — natural expiry still resolves this poll
    }
    if (!snapshot) continue; // hidden tallies — cannot make a trustworthy early call

    const expiresAt = new Date(row.poll_expires_at);
    const openedAt = new Date(expiresAt.getTime() - row.poll_duration_sec * 1000);

    const fingerprint = tallyFingerprint(snapshot.tallies);
    let changedAt: Date;
    if (row.watched_tally_json === null && row.watched_votes !== null) {
      if (snapshot.totalVotes !== row.watched_votes) {
        db.prepare(
          `UPDATE rounds SET watched_votes = ?, watched_tally_json = ?, votes_changed_at = ?
           WHERE game_id = ? AND number = ? AND status = 'poll_open' AND poll_id = ?`,
        ).run(snapshot.totalVotes, fingerprint, nowIso, row.game_id, row.number, row.poll_id);
        continue;
      }
      changedAt = new Date(row.votes_changed_at ?? openedAt.toISOString());
      db.prepare(
        `UPDATE rounds SET watched_tally_json = ?
         WHERE game_id = ? AND number = ? AND status = 'poll_open' AND poll_id = ?`,
      ).run(fingerprint, row.game_id, row.number, row.poll_id);
    } else if (row.watched_tally_json === null) {
      changedAt = snapshot.totalVotes === 0 ? openedAt : now;
      db.prepare(
        `UPDATE rounds SET watched_votes = ?, watched_tally_json = ?, votes_changed_at = ?
         WHERE game_id = ? AND number = ? AND status = 'poll_open' AND poll_id = ?`,
      ).run(
        snapshot.totalVotes,
        fingerprint,
        changedAt.toISOString(),
        row.game_id,
        row.number,
        row.poll_id,
      );
    } else if (fingerprint !== row.watched_tally_json) {
      db.prepare(
        `UPDATE rounds SET watched_votes = ?, watched_tally_json = ?, votes_changed_at = ?
         WHERE game_id = ? AND number = ? AND status = 'poll_open' AND poll_id = ?`,
      ).run(snapshot.totalVotes, fingerprint, nowIso, row.game_id, row.number, row.poll_id);
      continue;
    } else {
      changedAt = new Date(row.votes_changed_at ?? openedAt.toISOString());
    }

    const ageSec = (now.getTime() - openedAt.getTime()) / 1000;
    const stillSec = (now.getTime() - changedAt.getTime()) / 1000;
    if (ageSec < ec.minAgeSec || stillSec < ec.stagnationSec) continue;
    if (expiresAt.getTime() <= now.getTime()) continue; // due sweep owns it

    const resolution = await resolvePollRow(
      handler,
      row.game_id,
      row.number,
      row.poll_id,
      row.option_map_json,
      now,
      snapshot.tallies,
      true,
      async () => {
        let deleted = false;
        try {
          await handler.client.delete(`/api/v1/statuses/${row.poll_status_id}`);
          deleted = true;
        } catch (err) {
          if (err instanceof MastodonApiError && (err.status === 404 || err.status === 410)) {
            deleted = true;
          } else {
            handler.log?.("early-close poll cleanup failed; will retry", {
              gameId: row.game_id,
              round: row.number,
              pollStatusId: row.poll_status_id,
              err,
            });
          }
        }
        if (!deleted) return false;
        handler.db
          .prepare(
            `UPDATE rounds SET poll_cleanup_pending = 0, poll_status_id = NULL, poll_id = NULL, poll_expires_at = NULL
             WHERE game_id = ? AND number = ? AND poll_id = ?`,
          )
          .run(row.game_id, row.number, row.poll_id);
        return true;
      },
    );
    if (resolution === "cleanup_pending") continue;
  }
}

/** Entry point for `type=poll` notifications (fast path) — resolves immediately if due. */
export async function checkPollNotification(
  deps: SchedulerDeps,
  statusId: string | null,
): Promise<boolean> {
  if (!statusId) return false;
  const db = deps.handler.db;
  const row = db
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
  if (!row) return false;
  if (!row.poll_expires_at || new Date(row.poll_expires_at).getTime() > deps.now().getTime()) {
    return false;
  }
  await resolvePollRow(deps.handler, row.game_id, row.number, row.poll_id, row.option_map_json, deps.now());
  return true;
}

/**
 * In-process claim per (game, round): the 60s sweep and the notification
 * fast-path run on independent timers, so both can race for the same poll.
 * Whoever fails to claim defers to the holder; the status re-check under the
 * claim skips rows the holder already resolved.
 *
 * Scoped to this process — sufficient for the single-container deployment. Two
 * processes sharing one SQLite file would need a database-level lease instead.
 */
const resolvingPolls = new Set<string>();

type PollResolutionResult =
  | "resolved"
  | "already_resolved"
  | "lost_claim"
  | "state_changed"
  | "cleanup_pending";

async function recoverPendingRoundResults(
  handler: HandlerDeps,
  gameId: string,
  throughRound: number,
): Promise<boolean> {
  for (let round = 1; round <= throughRound; round += 1) {
    const row = loadRound(handler.db, gameId, round);
    if (!row || !["resolved", "auto_tied", "walkover"].includes(row.status)) continue;
    if (!await recoverRoundResult(handler, gameId, round)) return false;
  }
  return true;
}

async function continueRecoveredRound(
  handler: HandlerDeps,
  gameId: string,
  round: number,
  now: Date,
): Promise<void> {
  const game = loadGame(handler.db, gameId);
  if (!game || isTerminal(game.status)) return;
  if (round >= game.playlistLength) {
    await advanceToFinaleIfFinal(handler, gameId, now);
    return;
  }
  if (game.currentRound === round) {
    const changed = handler.db
      .prepare(
        "UPDATE games SET current_round = ?, updated_at = ? WHERE id = ? AND status = 'ROUND' AND current_round = ?",
      )
      .run(round + 1, now.toISOString(), gameId, round);
    if (changed.changes !== 1) return;
  } else if (game.currentRound !== round + 1) {
    return;
  }
  await emitRound(handler, gameId, round + 1);
}

async function resolvePollRow(
  handler: HandlerDeps,
  gameId: string,
  roundNumber: number,
  pollId: string,
  optionMapJson: string,
  now: Date,
  prefetchedTallies?: { accountId: string; votes: number }[],
  pollCleanupPending = false,
  beforeResult?: () => Promise<boolean>,
): Promise<PollResolutionResult> {
  const key = `${gameId}#${roundNumber}`;
  if (resolvingPolls.has(key)) return "lost_claim";
  resolvingPolls.add(key);
  try {
    const db = handler.db;
    const round = db
      .prepare("SELECT status, poll_id FROM rounds WHERE game_id = ? AND number = ?")
      .get(gameId, roundNumber) as { status: string; poll_id: string | null } | undefined;
    if (round?.status !== "poll_open") return "already_resolved";
    if (round.poll_id !== pollId) return "state_changed";

    const game = loadGame(db, gameId);
    if (!game || game.status !== "ROUND" || game.currentRound !== roundNumber) return "state_changed";
    const optionMap = JSON.parse(optionMapJson) as Record<string, string>;

    const tallies = prefetchedTallies ?? (await tallyPoll(handler.client, pollId, optionMap));
    const liveGame = loadGame(db, gameId);
    const liveRound = db
      .prepare("SELECT status, poll_id FROM rounds WHERE game_id = ? AND number = ?")
      .get(gameId, roundNumber) as { status: string; poll_id: string | null } | undefined;
    if (
      !liveGame ||
      liveGame.status !== "ROUND" ||
      liveGame.currentRound !== roundNumber ||
      liveRound?.status !== "poll_open" ||
      liveRound.poll_id !== pollId
    ) {
      return "state_changed";
    }

    const outcome = resolveRound({
      game: liveGame,
      players: loadPlayers(db, gameId),
      tallies,
      roundNumber,
      playlistLength: liveGame.playlistLength,
      now,
    });

    const finalSplit: FinalSplit | null = outcome.finalSplit;
    const winnerPlayer = outcome.winnerAccountId
      ? outcome.players.find((p) => p.accountId === outcome.winnerAccountId)
      : null;
    const resolutionInput: TallyInput = {
      round: roundNumber,
      winnerAcct: winnerPlayer?.acct ?? null,
      potAwarded: outcome.potAwarded,
      wasTie: outcome.winnerAccountId === null,
      newPot: outcome.game.pot,
      potSplit: finalSplit,
    };
    db.transaction(() => {
      for (const p of outcome.players) savePlayer(db, gameId, p);
      if (!saveGame(db, outcome.game, "ROUND")) {
        throw new Error(`Game ${gameId} changed state before round ${roundNumber} could be resolved`);
      }
      markRoundResolved(
        db,
        gameId,
        roundNumber,
        outcome.winnerAccountId,
        finalSplit ? { finalSplit } : {},
        pollCleanupPending,
        JSON.stringify(resolutionInput),
      );
    })();

    const persistedGame = loadGame(db, gameId);
    if (!persistedGame || isTerminal(persistedGame.status)) return "resolved";
    if (beforeResult && !(await beforeResult())) return "cleanup_pending";

    if (!await postRoundResult(handler, gameId, roundNumber, resolutionInput)) return "resolved";

    const afterPost = loadGame(db, gameId);
    if (!afterPost || isTerminal(afterPost.status)) return "resolved";

    if (outcome.nextState === "FINALE") {
      await emitFinale(handler, gameId);
      return "resolved";
    }

    // next round — only emit if players actually have tunes for it; otherwise
    // the emitRound walkover/auto-tie logic handles remaining empty rounds.
    await emitRound(handler, gameId, roundNumber + 1);
    return "resolved";
  } finally {
    resolvingPolls.delete(key);
  }
}

type CreationVisibility = "public" | "unlisted" | "private";

async function resumeCreatedGames(deps: SchedulerDeps): Promise<void> {
  const { handler } = deps;
  const rows = handler.db
    .prepare(
      `SELECT id, creation_status_id, creation_visibility
       FROM games WHERE status = 'CREATED'`,
    )
    .all() as { id: string; creation_status_id: string | null; creation_visibility: string }[];

  for (const row of rows) {
    const game = loadGame(handler.db, row.id);
    if (!game || !row.creation_status_id) continue;
    if (row.creation_visibility === "private") {
      const changed = handler.db
        .prepare(
          "UPDATE games SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND status = 'CREATED'",
        )
        .run(deps.now().toISOString(), game.id);
      if (changed.changes === 1) {
        try {
          await handler.client.post<{ id: string }>("/api/v1/statuses", {
            status: m().sideCancelled(game.theme),
            in_reply_to_id: row.creation_status_id,
            visibility: "private",
          }, { idempotencyKey: `pb:v1:creation:${row.creation_status_id}:private-cancel` });
        } catch (err) {
          handler.log?.("private creation cancellation notice failed", { gameId: game.id, err });
        }
      }
      continue;
    }
    const visibility: CreationVisibility =
      row.creation_visibility === "unlisted" || row.creation_visibility === "private"
        ? row.creation_visibility
        : "public";
    try {
      let rootReplyId = game.threadRootId;
      if (!rootReplyId) {
        const summary = m().gameCreated(
          game.theme,
          game.playlistLength,
          loadPlayers(handler.db, game.id).length,
          game.acceptanceDeadline ?? "",
          game.id,
        );
        assertPostLength(summary);
        const posted = await handler.client.post<{ id: string }>("/api/v1/statuses", {
          status: summary,
          in_reply_to_id: row.creation_status_id,
          visibility,
        }, { idempotencyKey: `pb:v1:creation:${row.creation_status_id}:root` });
        rootReplyId = posted.id;
        if (!saveGame(handler.db, { ...game, threadRootId: rootReplyId }, "CREATED")) continue;
      }

      const players = loadPlayers(handler.db, game.id);
      const hostAcct = players.find((p) => p.role === "host")?.acct ?? "?";
      for (const player of players.filter((p) => p.inviteStatus === "pending")) {
        const sent = handler.db
          .prepare("SELECT invite_sent_at FROM players WHERE game_id = ? AND account_id = ?")
          .get(game.id, player.accountId) as { invite_sent_at: string | null } | undefined;
        if (sent?.invite_sent_at) continue;
        const text = m().inviteDm(
          game.theme,
          hostAcct,
          game.playlistLength,
          game.acceptanceDeadline ?? "",
        );
        await dm(
          handler.db,
          handler.client,
          player.accountId,
          text,
          player.acct,
          { idempotencyKey: `pb:v1:creation:${game.id}:invite:${player.accountId}` },
          handler.instanceDomain,
        );
        handler.db
          .prepare("UPDATE players SET invite_sent_at = ? WHERE game_id = ? AND account_id = ?")
          .run(deps.now().toISOString(), game.id, player.accountId);
      }
      saveGame(
        handler.db,
        { ...game, status: "INVITED", threadRootId: rootReplyId, updatedAt: deps.now().toISOString() },
        "CREATED",
      );
    } catch (err) {
      handler.log?.("created game recovery failed; will retry", {
        gameId: game.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Boot-time / periodic resume of open games (PRD §7 restart).
 * Sweeps deadlines + polls, then recovers games stuck mid-transition:
 * - READY (crash before round 1 emit) → start round 1
 * - FINALE (crash before close) → post finale thread + close
 */
export async function resumeOpenGames(deps: SchedulerDeps): Promise<void> {
  const { handler } = deps;
  const db = handler.db;

  await resumeCreatedGames(deps);
  await checkDeadlines(deps);
  await checkPolls(deps);

  // READY stuck: finished collection but never emitted round 1
  const readies = db
    .prepare(`SELECT id FROM games WHERE status = 'READY'`)
    .all() as { id: string }[];
  for (const { id } of readies) {
    const started = startRound(loadGame(db, id)!, 1, deps.now());
    if (!saveGame(db, started, "READY")) continue;
    await emitRound(handler, id, 1);
  }

  const roundGames = db
    .prepare("SELECT id, current_round FROM games WHERE status = 'ROUND'")
    .all() as { id: string; current_round: number }[];
  for (const { id, current_round } of roundGames) {
    const game = loadGame(db, id);
    if (!game) continue;
    const round = current_round > 0 ? current_round : 1;
    if (!await recoverPendingRoundResults(handler, id, round)) continue;
    const row = loadRound(db, id, round);
    if (!row) {
      await emitRound(handler, id, round);
      continue;
    }
    if (["resolved", "auto_tied", "walkover"].includes(row.status)) {
      if (!await recoverRoundResult(handler, id, round)) continue;
      await continueRecoveredRound(handler, id, round, deps.now());
    }
  }

  // FINALE stuck: never posted/closed
  const finales = db
    .prepare(`SELECT id FROM games WHERE status = 'FINALE'`)
    .all() as { id: string }[];
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
