import { NON_TERMINAL_STATUS_SQL } from "../db/index.js";
import { loadGame } from "../game/store.js";
import type { Game, GameStatus } from "../game/types.js";
import { postSideEffect } from "../mastodon/posts.js";
import { MastodonApiError } from "../mastodon/client.js";
import type { HandlerDeps } from "./mention.js";

/**
 * Closing an open game. Two things void a game mid-flight: a player account
 * being deleted/unreachable (PRD §7 / v1.1 1.5) and the host cancelling
 * (RULES §4). Both own the same side effects — close the live polls, flip the
 * status, post the closure notice — so they share `voidOpenGame`.
 *
 * Lives outside mention.ts so roundState can import it without a runtime
 * circular dependency through the mention handler; the type-only HandlerDeps
 * import keeps the cycle type-level only.
 */

/** Which open statuses each closure applies to, and where it leaves the game. */
export const CLOSURES = {
  PLAYER_DELETED: {
    from: ["INVITED", "COLLECTING", "READY", "ROUND", "FINALE"],
    to: "FORFEIT",
    notice: "forfeit",
  },
  CANCEL: {
    from: ["CREATED", "INVITED", "COLLECTING", "ROUND"],
    to: "CANCELLED",
    notice: "cancelled",
  },
} as const satisfies Record<string, { from: readonly GameStatus[]; to: GameStatus; notice: string }>;

/**
 * Every open game the account participates in becomes FORFEIT (no champion);
 * the bot posts a closure notice on each creation thread. Returns the game IDs
 * that were closed.
 */
export async function handlePlayerDeleted(deps: HandlerDeps, accountId: string): Promise<string[]> {
  const rows = deps.db
    .prepare(
      `SELECT g.id FROM games g JOIN players p ON p.game_id = g.id
       WHERE p.account_id = ? AND g.status ${NON_TERMINAL_STATUS_SQL}`,
    )
    .all(accountId) as { id: string }[];

  const affected: string[] = [];
  for (const { id } of rows) {
    if (await voidOpenGame(deps, id, "PLAYER_DELETED")) affected.push(id);
  }
  return affected;
}

/**
 * Void an open game: close its live polls, move it to the closure's terminal
 * status, and post the matching notice. Returns the closed game, or null when
 * the game is missing or the closure does not apply from its state.
 */
export async function voidOpenGame(
  deps: HandlerDeps,
  gameId: string,
  kind: keyof typeof CLOSURES,
): Promise<Game | null> {
  const game = loadGame(deps.db, gameId);
  const closure = CLOSURES[kind];
  if (!game || !(closure.from as readonly GameStatus[]).includes(game.status)) return null;

  const changed = deps.db
    .prepare(
      "UPDATE games SET status = ?, pot = 0, updated_at = ? WHERE id = ? AND status = ?",
    )
    .run(closure.to, deps.now().toISOString(), gameId, game.status);
  if (changed.changes === 0) return null;
  await closeOpenRounds(deps, gameId);

  const voided: Game = { ...game, status: closure.to, pot: 0 };
  await postSideEffect(deps.client, voided, closure.notice);
  return voided;
}

/**
 * Delete a status, treating 404/410 as already gone. Any other failure is
 * logged and reported as false so the caller keeps its retry state.
 */
export async function removeStatus(
  deps: Pick<HandlerDeps, "client" | "logger">,
  statusId: string,
  context: Record<string, unknown>,
): Promise<boolean> {
  try {
    await deps.client.delete(`/api/v1/statuses/${statusId}`);
    return true;
  } catch (err) {
    if (err instanceof MastodonApiError && (err.status === 404 || err.status === 410)) return true;
    deps.logger?.warn({ ...context, statusId, err }, "status cleanup failed; will retry");
    return false;
  }
}

/**
 * A void game must not keep collecting votes: drop the transient replacement
 * windows, mark every still-open round resolved (terminal games are skipped by
 * the poll sweeps, so the row would otherwise sit at `poll_open` forever), and
 * best-effort remove its poll status.
 */
async function closeOpenRounds(deps: HandlerDeps, gameId: string): Promise<void> {
  deps.db
    .prepare(
      "UPDATE rounds SET poll_cleanup_pending = 1 WHERE game_id = ? AND status = 'announced'",
    )
    .run(gameId);

  const open = deps.db
    .prepare("SELECT number, poll_status_id FROM rounds WHERE game_id = ? AND status = 'poll_open'")
    .all(gameId) as { number: number; poll_status_id: string | null }[];

  for (const row of open) {
    const removed =
      !row.poll_status_id || (await removeStatus(deps, row.poll_status_id, { gameId, round: row.number }));
    if (!removed) continue;
    deps.db
      .prepare(
        `UPDATE rounds SET status = 'resolved', poll_status_id = NULL, poll_id = NULL, poll_expires_at = NULL
         WHERE game_id = ? AND number = ?`,
      )
      .run(gameId, row.number);
  }
}
