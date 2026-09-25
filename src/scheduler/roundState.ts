import type { Db } from "../db/index.js";
import type { HandlerDeps } from "../handlers/mention.js";
import { MastodonApiError } from "../mastodon/client.js";
import { eligibleForRound, hasRoundCollision, isTerminal, type Tune } from "../game/types.js";
import { champions } from "../game/scoring.js";
import { mulberry32, roundSeed, seededShuffle } from "../game/shuffle.js";
import {
  RESOLVED_ROUND_STATUSES,
  loadGame,
  loadPlayers,
  loadTunes,
  loadRound,
  loadRoundWinners,
  roundMeta,
  saveBattlePlaylistId,
  savePollRound,
  setGameStatus,
  type RoundMeta,
} from "../game/store.js";
import { postRound, postRoundResolution, postFinale, type TallyInput } from "../mastodon/posts.js";
import { dm } from "../mastodon/dm.js";
import { handlePlayerDeleted } from "../handlers/closure.js";
import { m } from "../i18n/index.js";

/**
 * Round + finale emission — the single owner of the post-round lifecycle.
 * Both the mention handler (walkover/auto-tie chains, first round) and the
 * scheduler (poll resolution, resume sweeps) route through these functions,
 * so there is exactly one implementation of each transition's side effects.
 */

/**
 * In-process claims: the availability window re-entry, the deadline sweep,
 * the poll fast-path and emitRound can race for the same round/finale/poll.
 * Whoever fails to claim defers to the holder. Scoped to this process —
 * sufficient for the single-container deployment; two processes sharing one
 * SQLite file would need a database-level lease instead.
 */
const claims = new Set<string>();

export function isClaimed(key: string): boolean {
  return claims.has(key);
}

export async function exclusively(key: string, task: () => Promise<void>): Promise<void> {
  if (claims.has(key)) return;
  claims.add(key);
  try {
    await task();
  } finally {
    claims.delete(key);
  }
}

function isLiveRound(db: Db, gameId: string, round: number): boolean {
  const game = loadGame(db, gameId);
  return game?.status === "ROUND" && game.currentRound === round;
}

/**
 * Final round resolved → move game to FINALE, post finale thread, mark CLOSED.
 */
async function advanceToFinaleIfFinal(handler: HandlerDeps, gameId: string): Promise<void> {
  const current = loadGame(handler.db, gameId);
  if (!current) return;
  if (current.status !== "FINALE") {
    if (current.status !== "ROUND" && current.status !== "READY") return;
    if (!setGameStatus(handler.db, gameId, current.status, "FINALE", handler.now())) return;
  }
  await emitFinale(handler, gameId);
}

/**
 * After `round` resolved (poll, auto-tie or walkover): emit the next round or
 * the finale. Idempotent, so recovery sweeps can call it again.
 */
export async function advanceAfterRound(handler: HandlerDeps, gameId: string, round: number): Promise<void> {
  const game = loadGame(handler.db, gameId);
  if (!game || isTerminal(game.status)) return;
  if (round >= game.playlistLength) {
    await advanceToFinaleIfFinal(handler, gameId);
    return;
  }
  if (game.currentRound === round) {
    const changed = handler.db
      .prepare(
        "UPDATE games SET current_round = ?, updated_at = ? WHERE id = ? AND status = 'ROUND' AND current_round = ?",
      )
      .run(round + 1, handler.now().toISOString(), gameId, round);
    if (changed.changes !== 1) return;
  } else if (game.currentRound !== round + 1) {
    return;
  }
  await emitRound(handler, gameId, round + 1);
}

/** Post round thread + poll (or auto-tie/walkover) for the given round. Persists rounds row. */
export async function emitRound(handler: HandlerDeps, gameId: string, round: number): Promise<void> {
  await exclusively(`round:${gameId}#${round}`, () => emitRoundInner(handler, gameId, round));
}

async function emitRoundInner(handler: HandlerDeps, gameId: string, round: number): Promise<void> {
  const db = handler.db;
  if (!isLiveRound(db, gameId, round)) return;

  let excluded = new Set<string>();
  const preliminaryEligible = eligibleForRound(loadPlayers(db, gameId), loadTunes(db, gameId), round);
  if (preliminaryEligible.length > 0) {
    const windowOutcome = await ensureAvailability(handler, gameId, round, preliminaryEligible);
    if (windowOutcome.kind !== "ready") {
      // Aborted means the game went terminal (unreachable player → FORFEIT) —
      // never publish a round thread onto a void game.
      if (windowOutcome.kind === "aborted") {
        db.prepare("DELETE FROM rounds WHERE game_id = ? AND number = ? AND status = 'announced'").run(gameId, round);
      }
      return;
    }
    excluded = windowOutcome.excluded;
  }

  const liveGame = loadGame(db, gameId);
  if (liveGame?.status !== "ROUND" || liveGame.currentRound !== round) return;
  const livePlayers = loadPlayers(db, gameId);
  const liveTunes = loadTunes(db, gameId);
  const eligible = eligibleForRound(livePlayers, liveTunes, round, excluded);
  const roundTunes = liveTunes
    .filter((t) => t.position === round && eligible.includes(t.accountId))
    .sort((a, b) => eligible.indexOf(a.accountId) - eligible.indexOf(b.accountId));
  const pot = liveGame.pot;

  // Walkover: only one player remains in this round (PRD §7 / v1.1 1.4)
  if (eligible.length <= 1) {
    const winner = eligible[0] ?? null;
    await resolveWithoutPoll(handler, gameId, round, {
      status: "walkover",
      winner,
      awards: winner ? [[winner, pot]] : [],
      pot: winner ? 0 : pot,
      meta: { participants: eligible },
      input: {
        round,
        winnerAcct: winner ? livePlayers.find((p) => p.accountId === winner)?.acct ?? winner : null,
        potAwarded: pot,
        wasTie: false,
        walkover: true,
        newPot: winner ? 0 : pot,
      },
    });
    return;
  }

  // Auto-tie: identical video across players → no poll (PRD §5.6)
  if (hasRoundCollision(roundTunes, round)) {
    if (round >= liveGame.playlistLength) {
      // v1.1 1.3: final-round auto-tie splits the pre-round pot among all
      // round participants (no poll ran, so everyone is "tied").
      const each = Math.floor(pot / eligible.length);
      const split = each > 0 ? { total: each * eligible.length, each, count: eligible.length } : null;
      await resolveWithoutPoll(handler, gameId, round, {
        status: "auto_tied",
        winner: null,
        awards: split ? eligible.map((id) => [id, each]) : [],
        pot: 0,
        meta: split ? { finalSplit: split, participants: eligible } : { participants: eligible },
        input: { round, winnerAcct: null, potAwarded: 0, wasTie: true, newPot: 0, potSplit: split },
      });
      return;
    }
    await resolveWithoutPoll(handler, gameId, round, {
      status: "auto_tied",
      winner: null,
      awards: [],
      pot: pot + 1,
      meta: { participants: eligible },
      input: { round, winnerAcct: null, potAwarded: 0, wasTie: true, newPot: pot + 1 },
    });
    return;
  }

  // v1.1 1.7: deterministic shuffle of poll option / announce order.
  const shuffled = seededShuffle(roundTunes, mulberry32(roundSeed(gameId, round)));
  db.prepare(
    `INSERT OR REPLACE INTO rounds (game_id, number, status, option_map_json)
     VALUES (?, ?, 'announced', '{"preparing":true,"publishing":true}')`,
  ).run(gameId, round);

  const result = await postRound(handler.client, liveGame, livePlayers, shuffled, round);
  const persisted = db.transaction(() => {
    if (loadRound(db, gameId, round)?.status !== "announced") return false;
    return savePollRound(
      db,
      gameId,
      round,
      result.pollStatusId,
      result.pollId,
      result.pollExpiresAt,
      result.optionMap,
      !isLiveRound(db, gameId, round),
    );
  })();
  if (!persisted) {
    try {
      await handler.client.delete(`/api/v1/statuses/${result.pollStatusId}`);
    } catch {
      // Orphaned poll: nothing references it any more.
    }
  }
}

/** Persist a round decided without a poll (walkover / auto-tie), post its result, move on. */
async function resolveWithoutPoll(
  handler: HandlerDeps,
  gameId: string,
  round: number,
  r: {
    status: "walkover" | "auto_tied";
    winner: string | null;
    awards: [accountId: string, points: number][];
    pot: number;
    meta: RoundMeta;
    input: TallyInput;
  },
): Promise<void> {
  const db = handler.db;
  const committed = db.transaction(() => {
    if (!isLiveRound(db, gameId, round)) return false;
    db.prepare(
      `INSERT OR REPLACE INTO rounds
        (game_id, number, status, winner_account_id, option_map_json, resolution_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(gameId, round, r.status, r.winner, JSON.stringify(r.meta), JSON.stringify(r.input));
    for (const [accountId, points] of r.awards) {
      db.prepare("UPDATE players SET points = points + ? WHERE game_id = ? AND account_id = ?").run(
        points, gameId, accountId,
      );
    }
    db.prepare("UPDATE games SET pot = ? WHERE id = ?").run(r.pot, gameId);
    return true;
  })();
  if (!committed) return;
  if (!await postRoundResult(handler, gameId, round, r.input)) return;
  await advanceAfterRound(handler, gameId, round);
}

export async function postRoundResult(
  handler: HandlerDeps,
  gameId: string,
  round: number,
  input: TallyInput,
): Promise<boolean> {
  const game = loadGame(handler.db, gameId);
  if (!game || isTerminal(game.status)) return false;
  await postRoundResolution(handler.client, game, loadPlayers(handler.db, gameId), input);
  handler.db
    .prepare(
      `UPDATE rounds SET resolution_posted_at = ?
       WHERE game_id = ? AND number = ? AND status IN ('resolved', 'auto_tied', 'walkover')`,
    )
    .run(handler.now().toISOString(), gameId, round);
  return true;
}

/** Post a persisted-but-unposted round result. False when the game went terminal first. */
export async function recoverRoundResult(
  handler: HandlerDeps,
  gameId: string,
  round: number,
): Promise<boolean> {
  const row = loadRound(handler.db, gameId, round);
  if (!row || row.resolution_posted_at || !RESOLVED_ROUND_STATUSES.includes(row.status)) return true;
  const game = loadGame(handler.db, gameId);
  if (!game || isTerminal(game.status)) return false;
  let input: unknown;
  try {
    input = JSON.parse(row.resolution_json ?? "null");
  } catch {
    return true;
  }
  if (!input || typeof input !== "object") return true;
  return postRoundResult(handler, gameId, round, input as TallyInput);
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
async function ensureAvailability(
  handler: HandlerDeps,
  gameId: string,
  round: number,
  eligibleIds: string[],
): Promise<AvailabilityOutcome> {
  const db = handler.db;
  const tunes = new Map<string, Tune>();
  for (const t of loadTunes(db, gameId)) if (t.position === round) tunes.set(t.accountId, t);
  const deadIds = async (): Promise<string[]> => {
    const dead: string[] = [];
    for (const id of eligibleIds) {
      const tune = tunes.get(id);
      if (tune && !(await handler.checkAvailable(tune.videoId))) dead.push(id);
    }
    return dead;
  };
  const publish = (excluded = new Set<string>()): AvailabilityOutcome => {
    db.prepare("DELETE FROM rounds WHERE game_id = ? AND number = ? AND status = 'announced'").run(gameId, round);
    return { kind: "ready", excluded };
  };

  const dead = await deadIds();
  // All healthy (replacement arrived or false alarm) → publish now.
  if (dead.length === 0) return publish();

  const existing = loadRound(db, gameId, round);
  const windowExists = existing?.status === "announced";
  const now = handler.now();
  let deadline: string;
  let notified: Set<string>;
  let prompts: Record<string, string>;
  if (windowExists) {
    const meta = roundMeta(existing).replacement ?? {};
    // Window closed — exclude still-dead players (round forfeit only).
    if (!meta.deadline || now.getTime() >= new Date(meta.deadline).getTime()) return publish(new Set(dead));
    deadline = meta.deadline;
    notified = new Set(meta.notified ?? []);
    prompts = { ...(meta.prompts ?? {}) };
  } else {
    deadline = new Date(now.getTime() + handler.replacementGraceMin * 60_000).toISOString();
    notified = new Set();
    prompts = {};
  }

  for (const accountId of dead) {
    const tune = tunes.get(accountId)!;
    if (notified.has(accountId)) continue;
    try {
      prompts[accountId] = await dm(
        handler,
        accountId,
        m().replaceTuneDm(tune.position, round, tune.title, deadline),
      );
      notified.add(accountId);
    } catch (err) {
      if (err instanceof MastodonApiError && [403, 404, 410].includes(err.status)) {
        await handlePlayerDeleted(handler, accountId);
        return { kind: "aborted" };
      }
      handler.logger?.warn(
        { accountId, round, err: err instanceof Error ? err.message : String(err) },
        "replacement DM failed; retrying later",
      );
    }
  }

  const replacement = JSON.stringify({ replacement: { deadline, notified: [...notified], prompts } });
  if (!windowExists) {
    if (!isLiveRound(db, gameId, round)) return { kind: "aborted" };
    db.prepare(
      `INSERT OR REPLACE INTO rounds (game_id, number, status, option_map_json)
       VALUES (?, ?, 'announced', ?)`,
    ).run(gameId, round, replacement);
    return { kind: "waiting" };
  }
  db.prepare(
    `UPDATE rounds SET option_map_json = ? WHERE game_id = ? AND number = ? AND status = 'announced'`,
  ).run(replacement, gameId, round);
  // If everything is healthy now (replacements arrived), publish.
  return (await deadIds()).length === 0 ? publish() : { kind: "waiting" };
}

/** Load round winners and post the finale thread, then close the game (PRD §5.7). */
export async function emitFinale(handler: HandlerDeps, gameId: string): Promise<void> {
  await exclusively(`finale:${gameId}`, () => emitFinaleInner(handler, gameId));
}

async function emitFinaleInner(handler: HandlerDeps, gameId: string): Promise<void> {
  const db = handler.db;
  const game = loadGame(db, gameId);
  if (!game || game.status !== "FINALE") return;
  if (!await recoverRoundResults(handler, gameId, game.playlistLength)) return;
  const players = loadPlayers(db, gameId);
  const tunes = loadTunes(db, gameId);

  const winningTunes = loadRoundWinners(db, gameId).flatMap((r) => {
    const t = tunes.find((x) => x.accountId === r.winner_account_id && x.position === r.number);
    return t ? [{ ...t, round: r.number }] : [];
  });

  const participated = new Set<string>();
  for (let round = 1; round <= game.playlistLength; round += 1) {
    const row = loadRound(db, gameId, round);
    if (!row) continue;
    const meta = roundMeta(row);
    if (Array.isArray(meta.participants)) {
      for (const id of meta.participants) participated.add(id);
      continue;
    }
    const mapped = Object.entries(row.option_map)
      .filter(([key]) => /^\d+$/.test(key))
      .map(([, id]) => id)
      .filter((id): id is string => typeof id === "string");
    if (mapped.length > 0) {
      for (const id of mapped) participated.add(id);
    } else {
      for (const tune of tunes.filter((t) => t.position === round)) participated.add(tune.accountId);
    }
  }
  const duelers = players.filter(
    (p) => p.inviteStatus === "accepted" && (participated.size === 0 || participated.has(p.accountId)),
  );

  // v1.1 1.3: final-round tie splits the pot (persisted as finalSplit meta).
  const finalRound = loadRound(db, gameId, game.playlistLength);
  const finalTied =
    !finalRound || finalRound.status === "auto_tied" || finalRound.winner_account_id === null;
  let potSplit: { total: number; each: number; count: number } | null = null;
  if (finalTied) {
    const meta = roundMeta(finalRound).finalSplit ?? null;
    if (meta && meta.total > 0) {
      potSplit = { total: meta.total, each: meta.each, count: meta.count };
    }
    if (game.pot > 0) {
      // Walkover-final with null winner: leftover pot is silently zeroed.
      db.prepare("UPDATE games SET pot = 0 WHERE id = ?").run(gameId);
    }
  }

  // One link to the whole battle: a saved YT Music playlist when the bot
  // account is configured, an anonymous YouTube queue otherwise. Best-effort —
  // the finale posts its standings and per-round winners either way.
  const persistedQueue = db
    .prepare("SELECT finale_queue_url FROM games WHERE id = ?")
    .get(gameId) as { finale_queue_url: string | null } | undefined;
  let queueUrl = persistedQueue?.finale_queue_url ?? null;
  if (queueUrl === null) {
    const link = await handler.publishBattlePlaylist({
      theme: game.theme,
      rounds: game.playlistLength,
      tunes: winningTunes.map((t) => ({ round: t.round, videoId: t.videoId })),
      existingPlaylistId: game.battlePlaylistId,
    });
    queueUrl = link?.url ?? null;
    if (queueUrl !== null) {
      db.prepare("UPDATE games SET finale_queue_url = ? WHERE id = ?").run(queueUrl, gameId);
    }
    if (link?.playlistId && link.playlistId !== game.battlePlaylistId) {
      saveBattlePlaylistId(db, gameId, link.playlistId);
    }
  }

  await postFinale(handler.client, game, duelers, champions(duelers), winningTunes, {
    duelThreadId: game.threadRootId,
    potSplit,
    queueUrl,
  });

  setGameStatus(db, gameId, "FINALE", "CLOSED", handler.now());
}
