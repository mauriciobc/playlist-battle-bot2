import { loadGame, openGamesForAccount, pendingInviteGameId, saveGameState } from "../db/games.js";
import { loadPlayers } from "../db/players.js";
import { acceptInvite, declineInvite, ValidationError } from "../game/engine.js";
import type { Game, Player } from "../game/types.js";
import { m } from "../i18n/index.js";
import { dm, dmAuthor } from "../mastodon/dm.js";
import { addSeconds } from "../time.js";
import type { CommandInput, Handled, HandlerDeps, HandlerResult } from "./deps.js";

/** A game and its players around an invite: as found pending, or as answered. */
type Invitation = { game: Game; players: Player[] };

/** A challenger joins; the first acceptance opens submissions and prompts every accepted player. */
export function handleAccept(input: CommandInput, deps: HandlerDeps): Promise<HandlerResult> {
  return answerPendingInvite(input, deps, async (pending) => {
    assertBelowGameLimit(input, deps, pending.game.id);
    const accepted = acceptInvite(pending.game, pending.players, input.accountId, deps.now());
    const submissionDeadline = accepted.firstAccept
      ? addSeconds(deps.now(), deps.submissionWindowSec).toISOString()
      : accepted.game.submissionDeadline;
    saveAnsweredInvite(deps, pending, { game: { ...accepted.game, submissionDeadline }, players: accepted.players });

    await dmAuthor(deps, input, m().youAreIn());
    if (accepted.firstAccept) await promptSubmissions(deps, accepted.players, pending.game.playlistLength);
    return { handled: true, kind: "accepted", detail: accepted.firstAccept ? "first" : "subsequent" };
  });
}

export function handleDecline(input: CommandInput, deps: HandlerDeps): Promise<HandlerResult> {
  return answerPendingInvite(input, deps, async (pending) => {
    saveAnsweredInvite(deps, pending, declineInvite(pending.game, pending.players, input.accountId));
    await dmAuthor(deps, input, m().declined());
    return { handled: true, kind: "declined" };
  });
}

/**
 * Run `answer` on the author's most recent pending invite. A rule violation
 * reaches the author as its own message; anything else as a generic error.
 */
async function answerPendingInvite(
  input: CommandInput,
  deps: HandlerDeps,
  answer: (pending: Invitation) => Promise<Handled>,
): Promise<HandlerResult> {
  const gameId = pendingInviteGameId(deps.db, input.accountId, deps.now());
  if (!gameId) {
    await dmAuthor(deps, input, m().noInvitation());
    return { handled: true, kind: "no_invitation" };
  }

  const pending: Invitation = { game: loadGame(deps.db, gameId)!, players: loadPlayers(deps.db, gameId) };
  try {
    return await answer(pending);
  } catch (err) {
    const message = err instanceof ValidationError ? err.message : m().invitationError();
    await dmAuthor(deps, input, message);
    return { handled: true, kind: "error", detail: message };
  }
}

/** Joining must not take the player past the open-games limit (this game counts once joined). */
function assertBelowGameLimit(input: CommandInput, deps: HandlerDeps, gameId: string): void {
  const otherGames = openGamesForAccount(deps.db, input.accountId).filter((open) => open.id !== gameId);
  if (otherGames.length >= deps.maxGamesPerPlayer) {
    throw new ValidationError(m().errConcurrentGames(otherGames.length + 1, deps.maxGamesPerPlayer));
  }
}

/** Persist the answer while the game is still where the pending invite found it. */
function saveAnsweredInvite(deps: HandlerDeps, pending: Invitation, answered: Invitation): void {
  const game = { ...answered.game, updatedAt: deps.now().toISOString() };
  if (!saveGameState(deps.db, game, answered.players, pending.game.status)) {
    throw new Error("Game changed while processing invitation");
  }
}

/**
 * `players` is exactly what was just persisted, so the prompts go to everyone
 * now accepted without re-reading the table.
 */
async function promptSubmissions(deps: HandlerDeps, players: Player[], playlistLength: number): Promise<void> {
  for (const player of players.filter((p) => p.inviteStatus === "accepted")) {
    await dm(deps, player.accountId, m().submitFirst(playlistLength));
  }
}
