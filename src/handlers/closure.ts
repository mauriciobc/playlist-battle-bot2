import { loadGame, openGamesForAccount, voidGame } from "../db/games.js";
import { closePollRound, openPollRounds } from "../db/rounds.js";
import type { Game, GameStatus } from "../game/types.js";
import { postSideEffect } from "../mastodon/posts.js";
import { MastodonApiError } from "../mastodon/client.js";
import type { HandlerDeps } from "./deps.js";

/**
 * Closing an open game. Two things void a game mid-flight: a player account
 * being deleted/unreachable (PRD §7 / v1.1 1.5) and the host cancelling
 * (RULES §4). Both own the same side effects — close the live polls, flip the
 * status, post the closure notice — so they share `voidOpenGame`.
 *
 * Kept apart from the DM handlers so roundState can import it without a
 * runtime import cycle (the submission handler imports roundState).
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

/** A status delete answered with one of these means the status is already gone. */
const HTTP_NOT_FOUND = 404;
const HTTP_GONE = 410;

/**
 * Every open game the account participates in becomes FORFEIT (no champion);
 * the bot posts a closure notice on each creation thread. Returns the game IDs
 * that were closed.
 */
export async function handlePlayerDeleted(deps: HandlerDeps, accountId: string): Promise<string[]> {
  const affected: string[] = [];
  for (const { id } of openGamesForAccount(deps.db, accountId)) {
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
  const closureApplies = game !== null && (closure.from as readonly GameStatus[]).includes(game.status);
  if (!closureApplies) return null;
  if (!voidGame(deps.db, gameId, game.status, closure.to, deps.now())) return null;
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
    const alreadyGone = err instanceof MastodonApiError && (err.status === HTTP_NOT_FOUND || err.status === HTTP_GONE);
    if (alreadyGone) return true;
    deps.logger?.warn({ ...context, statusId, err }, "status cleanup failed; will retry");
    return false;
  }
}

/**
 * A void game must not keep collecting votes: mark every still-open poll
 * round resolved (terminal games are skipped by the poll sweeps, so the row
 * would otherwise sit at `poll_open` forever) and best-effort remove its poll
 * status. Its announced rounds need nothing: every reader of a replacement
 * window requires a live game, and a round that is mid-publish is flagged by
 * savePostedPoll itself once its poll lands.
 */
async function closeOpenRounds(deps: HandlerDeps, gameId: string): Promise<void> {
  for (const { round, pollStatusId } of openPollRounds(deps.db, gameId)) {
    const removed = !pollStatusId || (await removeStatus(deps, pollStatusId, { gameId, round }));
    if (removed) closePollRound(deps.db, gameId, round);
  }
}
