import type { Db } from "../db/index.js";
import type { HandlerDeps } from "../handlers/mention.js";
import { MastodonApiError } from "../mastodon/client.js";
import { eligibleForRound, hasRoundCollision, isTerminal } from "../game/types.js";
import { computeStandings } from "../game/scoring.js";
import { mulberry32, roundSeed, seededShuffle } from "../game/shuffle.js";
import {
  loadGame,
  loadPlayers,
  loadTunes,
  loadRound,
  loadRoundWinners,
  roundMeta,
  saveAutoTieRound,
  saveBattlePlaylistId,
  savePollRound,
  saveWalkoverRound,
} from "../game/store.js";
import type { RoundMeta } from "../game/store.js";
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
 * In-process claim per (game, round): the availability window re-entry, the
 * 60s deadline sweep, the poll fast-path and emitRound can race. Whoever fails
 * to claim defers to the holder.
 */
const emittingRounds = new Set<string>();
const emittingFinales = new Set<string>();

function claimEmit(gameId: string, round: number): boolean {
  const key = `${gameId}#${round}`;
  if (emittingRounds.has(key)) return false;
  emittingRounds.add(key);
  return true;
}

function releaseEmit(gameId: string, round: number): void {
  emittingRounds.delete(`${gameId}#${round}`);
}

/**
 * Final round resolved → move game to FINALE, post finale thread, mark CLOSED.
 */
export async function advanceToFinaleIfFinal(
  handler: HandlerDeps,
  gameId: string,
  now: Date,
): Promise<void> {
  const current = loadGame(handler.db, gameId);
  if (!current) return;
  if (current.status === "FINALE") {
    await emitFinale(handler, gameId);
    return;
  }
  if (current.status !== "ROUND" && current.status !== "READY") return;
  const changed = handler.db
    .prepare("UPDATE games SET status = 'FINALE', updated_at = ? WHERE id = ? AND status = ?")
    .run(now.toISOString(), gameId, current.status);
  if (changed.changes === 0) return;
  await emitFinale(handler, gameId);
}

/** Post round thread + poll (or auto-tie/walkover) for the given round. Persists rounds row. */
export async function emitRound(handler: HandlerDeps, gameId: string, round: number): Promise<void> {
  if (!claimEmit(gameId, round)) return;
  try {
    await emitRoundInner(handler, gameId, round);
  } finally {
    releaseEmit(gameId, round);
  }
}

async function emitRoundInner(handler: HandlerDeps, gameId: string, round: number): Promise<void> {
  const db = handler.db;
  const game = loadGame(db, gameId);
  if (!game || game.status !== "ROUND" || game.currentRound !== round) return;
  const players = loadPlayers(db, gameId);
  const allTunes = loadTunes(db, gameId);

  let excluded = new Set<string>();
  const preliminaryEligible = eligibleForRound(players, allTunes, round);
  if (preliminaryEligible.length > 0) {
    const windowOutcome = await ensureAvailability(handler, gameId, round, preliminaryEligible, allTunes);
    if (windowOutcome.kind !== "ready") {
      // Aborted means the game went terminal (unreachable player → FORFEIT) —
      // never publish a round thread onto a void game.
      if (windowOutcome.kind === "aborted") dropAnnouncedRound(db, gameId, round);
      return;
    }
    excluded = windowOutcome.excluded;
  }

  const liveGame = loadGame(db, gameId);
  if (!liveGame || liveGame.status !== "ROUND" || liveGame.currentRound !== round) return;
  const livePlayers = loadPlayers(db, gameId);
  const liveTunes = loadTunes(db, gameId);
  const eligible = eligibleForRound(livePlayers, liveTunes, round, excluded);
  const roundTunes = liveTunes
    .filter((t) => t.position === round && eligible.includes(t.accountId))
    .sort((a, b) => eligible.indexOf(a.accountId) - eligible.indexOf(b.accountId));

  // Walkover: only one player remains in this round (PRD §7 / v1.1 1.4)
  if (eligible.length <= 1) {
    const winner = eligible[0] ?? null;
    const potAwarded = liveGame.pot;
    const resolutionInput: TallyInput = {
      round,
      winnerAcct: winner
        ? livePlayers.find((p) => p.accountId === winner)?.acct ?? winner
        : null,
      potAwarded,
      wasTie: false,
      walkover: true,
      newPot: winner ? 0 : potAwarded,
    };
    const committed = db.transaction(() => {
      const liveGame = loadGame(db, gameId);
      if (!liveGame || liveGame.status !== "ROUND" || liveGame.currentRound !== round) return false;
      saveWalkoverRound(db, gameId, round, winner, eligible, JSON.stringify(resolutionInput));
      if (winner) {
        db.prepare("UPDATE players SET points = points + ? WHERE game_id = ? AND account_id = ?").run(
          potAwarded, gameId, winner,
        );
        db.prepare("UPDATE games SET pot = 0 WHERE id = ?").run(gameId);
      }
      return true;
    })();
    if (!committed) return;
    if (!await postRoundResult(handler, gameId, round, resolutionInput)) return;
    await advanceAfterRound(handler, gameId, round);
    return;
  }

  // Auto-tie: identical video across players → no poll (PRD §5.6)
  if (hasRoundCollision(roundTunes, round)) {
    const isFinal = round >= liveGame.playlistLength;
    if (isFinal) {
      // v1.1 1.3: final-round auto-tie splits the pre-round pot among all
      // round participants (no poll ran, so everyone is "tied").
      const tiedIds = eligible;
      const pot = liveGame.pot;
      const count = tiedIds.length;
      const each = count > 0 ? Math.floor(pot / count) : 0;
      const total = each * count;
      const resolutionInput: TallyInput = {
        round,
        winnerAcct: null,
        potAwarded: 0,
        wasTie: true,
        newPot: 0,
        potSplit: total > 0 ? { total, each, count } : null,
      };
      const committed = db.transaction(() => {
        const liveGame = loadGame(db, gameId);
        if (!liveGame || liveGame.status !== "ROUND" || liveGame.currentRound !== round) return false;
        if (total > 0) {
          for (const id of tiedIds) {
            db.prepare("UPDATE players SET points = points + ? WHERE game_id = ? AND account_id = ?").run(
              each, gameId, id,
            );
          }
        }
        db.prepare("UPDATE games SET pot = 0 WHERE id = ?").run(gameId);
        saveAutoTieRound(
          db,
          gameId,
          round,
          total > 0
            ? { finalSplit: { total, each, count }, participants: tiedIds }
            : { participants: tiedIds },
          JSON.stringify(resolutionInput),
        );
        return true;
      })();
      if (!committed) return;
      if (!await postRoundResult(handler, gameId, round, resolutionInput)) return;
      await advanceAfterRound(handler, gameId, round);
      return;
    }
    const newPot = liveGame.pot + 1;
    const tiedIds = eligible;
    const resolutionInput: TallyInput = {
      round,
      winnerAcct: null,
      potAwarded: 0,
      wasTie: true,
      newPot,
    };
    const committed = db.transaction(() => {
      const liveGame = loadGame(db, gameId);
      if (!liveGame || liveGame.status !== "ROUND" || liveGame.currentRound !== round) return false;
      saveAutoTieRound(db, gameId, round, { participants: tiedIds }, JSON.stringify(resolutionInput));
      db.prepare("UPDATE games SET pot = ? WHERE id = ?").run(newPot, gameId);
      return true;
    })();
    if (!committed) return;
    if (!await postRoundResult(handler, gameId, round, resolutionInput)) return;
    await advanceAfterRound(handler, gameId, round);
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
    const liveGame = loadGame(db, gameId);
    const row = loadRound(db, gameId, round);
    if (!row || row.status !== "announced") return false;
    const pending = !liveGame || liveGame.status !== "ROUND" || liveGame.currentRound !== round;
    return savePollRound(
      db,
      gameId,
      round,
      result.pollStatusId,
      result.pollId,
      result.pollExpiresAt,
      result.optionMap,
      pending,
    );
  })();
  if (!persisted) {
    try {
      await handler.client.delete(`/api/v1/statuses/${result.pollStatusId}`);
    } catch {
      return;
    }
  }
}

/** After a round resolves (or auto-ties/walks over): next round or finale. */
async function advanceAfterRound(handler: HandlerDeps, gameId: string, finishedRound: number): Promise<void> {
  const db = handler.db;
  const game = loadGame(db, gameId)!;
  if (finishedRound >= game.playlistLength) {
    await advanceToFinaleIfFinal(handler, gameId, handler.now());
    return;
  }
  const changed = db.prepare(
    "UPDATE games SET current_round = ?, updated_at = ? WHERE id = ? AND status = 'ROUND' AND current_round = ?",
  ).run(
    finishedRound + 1, handler.now().toISOString(), gameId, finishedRound,
  );
  if (changed.changes !== 1) return;
  await emitRound(handler, gameId, finishedRound + 1);
}

type AvailabilityOutcome =
  | { kind: "ready"; excluded: Set<string> }
  | { kind: "waiting" }
  /** The window closed the game (deleted/unreachable player): publish nothing. */
  | { kind: "aborted" };

function dropAnnouncedRound(db: Db, gameId: string, round: number): void {
  db.prepare("DELETE FROM rounds WHERE game_id = ? AND number = ? AND status = 'announced'").run(
    gameId,
    round,
  );
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

export async function recoverRoundResult(
  handler: HandlerDeps,
  gameId: string,
  round: number,
): Promise<boolean> {
  const row = loadRound(handler.db, gameId, round);
  if (!row || row.resolution_posted_at || !["resolved", "auto_tied", "walkover"].includes(row.status)) {
    return true;
  }
  const game = loadGame(handler.db, gameId);
  if (!game || isTerminal(game.status)) return false;
  if (!row.resolution_json) return true;
  let input: TallyInput;
  try {
    const parsed: unknown = JSON.parse(row.resolution_json);
    if (!parsed || typeof parsed !== "object") return true;
    input = parsed as TallyInput;
  } catch {
    return true;
  }
  return postRoundResult(handler, gameId, round, input);
}

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
function isUnreachableAccountError(err: unknown): boolean {
  return err instanceof MastodonApiError && [403, 404, 410].includes(err.status);
}

async function ensureAvailability(
  handler: HandlerDeps,
  gameId: string,
  round: number,
  eligibleIds: string[],
  allTunes: { accountId: string; position: number; videoId: string; title: string }[],
): Promise<AvailabilityOutcome> {
  const db = handler.db;
  const empty = new Set<string>();

  const tuneOf = (accountId: string) =>
    allTunes.find((t) => t.accountId === accountId && t.position === round);

  const checkAll = async (ids: string[]): Promise<string[]> => {
    const dead: string[] = [];
    for (const id of ids) {
      const tune = tuneOf(id);
      if (!tune) continue;
      const ok = await handler.checkAvailable(tune.videoId);
      if (!ok) dead.push(id);
    }
    return dead;
  };

  const existing = loadRound(db, gameId, round);
  const now = handler.now();
  const graceMs = handler.replacementGraceMin * 60 * 1000;

  if (!existing || existing.status !== "announced") {
    const dead = await checkAll(eligibleIds);
    if (dead.length === 0) return { kind: "ready", excluded: empty };

    const deadline = new Date(now.getTime() + graceMs).toISOString();
    const notified: string[] = [];
    const prompts: Record<string, string> = {};
    for (const accountId of dead) {
      const tune = tuneOf(accountId);
      if (!tune) continue;
      try {
        const promptId = await dm(
          db,
          handler.client,
          accountId,
          m().replaceTuneDm(tune.position, round, tune.title, deadline),
          undefined,
          {},
          handler.instanceDomain,
        );
        notified.push(accountId);
        prompts[accountId] = promptId;
      } catch (err) {
        if (isUnreachableAccountError(err)) {
          await handlePlayerDeleted(handler, accountId);
          return { kind: "aborted" };
        }
        handler.log?.("replacement DM failed; retrying later", {
          accountId,
          round,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const liveGame = loadGame(db, gameId);
    if (!liveGame || liveGame.status !== "ROUND" || liveGame.currentRound !== round) {
      return { kind: "aborted" };
    }
    db.prepare(
      `INSERT OR REPLACE INTO rounds (game_id, number, status, option_map_json)
       VALUES (?, ?, 'announced', ?)`,
    ).run(gameId, round, JSON.stringify({ replacement: { deadline, notified, prompts } }));
    return { kind: "waiting" };
  }

  // Announced row exists — evaluate the window.
  const meta: RoundMeta["replacement"] = roundMeta(existing).replacement ?? {}
  const deadlineMs = meta.deadline ? new Date(meta.deadline).getTime() : now.getTime();
  const notified = new Set(meta.notified ?? []);
  const prompts: Record<string, string> = { ...(meta.prompts ?? {}) };
  const windowOpen = now.getTime() < deadlineMs;

  const dead = await checkAll(eligibleIds);
  if (dead.length === 0) {
    // All healthy (replacement arrived or false alarm) → publish now.
    db.prepare("DELETE FROM rounds WHERE game_id = ? AND number = ? AND status = 'announced'").run(
      gameId, round,
    );
    return { kind: "ready", excluded: empty };
  }

  if (windowOpen) {
    const delivered = new Set(notified);
    for (const accountId of dead) {
      if (notified.has(accountId)) continue;
      const tune = tuneOf(accountId);
      if (!tune) continue;
      try {
        const promptId = await dm(
          db,
          handler.client,
          accountId,
          m().replaceTuneDm(
            tune.position,
            round,
            tune.title,
            meta.deadline ?? new Date(deadlineMs).toISOString(),
          ),
          undefined,
          {},
          handler.instanceDomain,
        );
        delivered.add(accountId);
        prompts[accountId] = promptId;
      } catch (err) {
        if (isUnreachableAccountError(err)) {
          await handlePlayerDeleted(handler, accountId);
          return { kind: "aborted" };
        }
        handler.log?.("replacement DM retry failed", {
          accountId,
          round,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const mergedNotified = [...delivered];
    db.prepare(
      `UPDATE rounds SET option_map_json = ? WHERE game_id = ? AND number = ? AND status = 'announced'`,
    ).run(
      JSON.stringify({
        replacement: { deadline: meta.deadline, notified: mergedNotified, prompts },
      }),
      gameId,
      round,
    );

    // If everything is healthy now (replacements arrived), fall through to publish.
    const stillDead = await checkAll(eligibleIds);
    if (stillDead.length === 0) {
      db.prepare("DELETE FROM rounds WHERE game_id = ? AND number = ? AND status = 'announced'").run(
        gameId, round,
      );
      return { kind: "ready", excluded: empty };
    }
    return { kind: "waiting" };
  }

  // Window closed — exclude still-dead players (round forfeit only).
  const excluded = new Set(dead);
  db.prepare("DELETE FROM rounds WHERE game_id = ? AND number = ? AND status = 'announced'").run(
    gameId, round,
  );
  return { kind: "ready", excluded };
}

/** Load round winners and post the finale thread, then close the game (PRD §5.7). */
export async function emitFinale(handler: HandlerDeps, gameId: string): Promise<void> {
  if (emittingFinales.has(gameId)) return;
  emittingFinales.add(gameId);
  try {
    await emitFinaleInner(handler, gameId);
  } finally {
    emittingFinales.delete(gameId);
  }
}

async function emitFinaleInner(handler: HandlerDeps, gameId: string): Promise<void> {
  const db = handler.db;
  const game = loadGame(db, gameId);
  if (!game || game.status !== "FINALE") return;
  for (let round = 1; round <= game.playlistLength; round += 1) {
    const row = loadRound(db, gameId, round);
    if (row && ["resolved", "auto_tied", "walkover"].includes(row.status)) {
      if (!await recoverRoundResult(handler, gameId, round)) return;
    }
  }
  const players = loadPlayers(db, gameId);
  const tunes = loadTunes(db, gameId);

  const roundRows = loadRoundWinners(db, gameId);
  const winningTunes = roundRows
    .map((r) => {
      const t = tunes.find((x) => x.accountId === r.winner_account_id && x.position === r.number);
      return t
        ? { round: r.number, accountId: r.winner_account_id, videoId: t.videoId, title: t.title, canonicalUrl: t.canonicalUrl }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

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
  const { champions } = computeStandings(duelers);

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

  await postFinale(handler.client, game, duelers, champions, winningTunes, {
    duelThreadId: game.threadRootId,
    potSplit,
    queueUrl,
  });

  db.prepare("UPDATE games SET status = 'CLOSED', updated_at = ? WHERE id = ? AND status = 'FINALE'").run(
    handler.now().toISOString(),
    gameId,
  );
}
