import {
  findGameByCreationStatus,
  insertGame,
  lastHostedCreation,
  latestOpenGameId,
  loadGame,
  openGamesForAccount,
  saveGame,
} from "../db/games.js";
import { insertPlayer, loadPlayers, markInviteSent, unsentInvites } from "../db/players.js";
import { errorMessage } from "../errors.js";
import { createGameInput, ValidationError } from "../game/engine.js";
import { assertCanCreateGame, RateLimitedError } from "../game/rateLimit.js";
import type { Game, Player } from "../game/types.js";
import { m } from "../i18n/index.js";
import { MastodonApiError } from "../mastodon/client.js";
import { dm } from "../mastodon/dm.js";
import type { PublicVisibility } from "../mastodon/notifications.js";
import { reply } from "../mastodon/reply.js";
import { htmlToText, parseCreateCommand, parseStatusCommand, type CreateCommand } from "./commands.js";
import type { CommandInput, Handled, HandlerDeps, HandlerResult } from "./deps.js";

type NewGameCommand = Exclude<CreateCommand, { error: string }>;

type Challenger = { accountId: string; acct: string };

/** The mention that created a game: its thread root replies to it, with its visibility. */
type CreationMention = { statusId: string; visibility: PublicVisibility };

/** Stack lines kept when logging an unexpected creation failure. */
const LOGGED_STACK_LINES = 5;

/** Stands in for the host's handle should the host row be missing. */
const UNKNOWN_HOST_ACCT = "?";

export async function handlePublicCommand(input: CommandInput, deps: HandlerDeps): Promise<HandlerResult> {
  const existingCreation = findGameByCreationStatus(deps.db, input.statusId);
  if (existingCreation) {
    if (existingCreation.creationVisibility === "private") return replyWithError(input, deps, m().errPrivateCreate());
    await completeCreation(deps, existingCreation.id, input.statusId, replyVisibility(input));
    return { handled: true, kind: "game_created", detail: existingCreation.id };
  }

  const text = htmlToText(input.content);
  if (parseStatusCommand(text, deps.botAcct)) return handleStatus(input, deps);

  const command = parseCreateCommand(text, deps.botAcct, deps.instanceDomain);
  if (command === null) return { handled: false, reason: "not a command" };
  if ("error" in command) return replyWithError(input, deps, command.error);
  if (replyVisibility(input) === "private") return replyWithError(input, deps, m().errPrivateCreate());
  return createGame(input, deps, command);
}

/**
 * Finish a CREATED game: post the thread root on the creation mention, DM
 * every invite not yet sent, then open it (INVITED). Every step is idempotent
 * and persisted as it lands, so a crash anywhere resumes here — from a
 * redelivered mention or from the scheduler's recovery sweep.
 */
export async function completeCreation(
  deps: HandlerDeps,
  gameId: string,
  creationStatusId: string,
  visibility: PublicVisibility,
): Promise<void> {
  const created = loadGame(deps.db, gameId);
  if (created?.status !== "CREATED") return;
  const players = loadPlayers(deps.db, gameId);

  const game = await ensureThreadRoot(deps, created, players, { statusId: creationStatusId, visibility });
  if (!game) return;
  await sendPendingInvites(deps, game, players);
  saveGame(deps.db, { ...game, status: "INVITED", updatedAt: deps.now().toISOString() }, "CREATED");
}

function replyVisibility(input: CommandInput): PublicVisibility {
  return input.visibility ?? "public";
}

async function replyWithError(input: CommandInput, deps: HandlerDeps, message: string): Promise<Handled> {
  await reply(deps, input.statusId, message, replyVisibility(input));
  return { handled: true, kind: "error", detail: message };
}

async function handleStatus(input: CommandInput, deps: HandlerDeps): Promise<HandlerResult> {
  const gameId = latestOpenGameId(deps.db, input.accountId);
  if (!gameId) {
    await reply(deps, input.statusId, m().statusNone(), replyVisibility(input));
    return { handled: true, kind: "status", detail: "none" };
  }

  const game = loadGame(deps.db, gameId)!;
  const players = loadPlayers(deps.db, gameId);
  await reply(deps, input.statusId, statusSummary(game, players), replyVisibility(input));
  return { handled: true, kind: "status", detail: game.id };
}

function statusSummary(game: Game, players: Player[]): string {
  const statusLabel = m().gameStatus(game.status, game.currentRound, game.playlistLength);
  const playersStr = players.map((p) => `@${p.acct} ${m().statusPoints(p.points)}`).join(", ");
  return [
    `${m().statusLabelStatus()}: ${statusLabel}`,
    `${m().statusLabelTheme()}: ${game.theme}`,
    `${m().statusLabelPot()}: ${game.pot}`,
    `${m().statusLabelPlayers()}: ${playersStr}`,
    `${m().statusLabelGameId()}: ${game.id}`,
  ].join("\n");
}

/**
 * A failure before the game row is persisted is answered on the mention; once
 * it is persisted, the notification is retried and `completeCreation` resumes.
 */
async function createGame(input: CommandInput, deps: HandlerDeps, command: NewGameCommand): Promise<HandlerResult> {
  let gameId: string;
  try {
    gameId = await persistNewGame(input, deps, command);
  } catch (err) {
    return reportCreationFailure(input, deps, err);
  }

  try {
    await completeCreation(deps, gameId, input.statusId, replyVisibility(input));
  } catch (err) {
    deps.logger?.warn(
      { statusId: input.statusId, err: errorMessage(err) },
      "game creation side effect failed; retrying notification",
    );
    throw err;
  }
  return { handled: true, kind: "game_created", detail: gameId };
}

/** Validate the command against the rate limits and store the CREATED game; returns its ID. */
async function persistNewGame(input: CommandInput, deps: HandlerDeps, command: NewGameCommand): Promise<string> {
  // Rate limits — open games + last hosted creation for this account only
  assertCanCreateGame(
    { creationCooldownSec: deps.creationCooldownSec, maxGamesPerPlayer: deps.maxGamesPerPlayer },
    deps.now(),
    lastHostedCreation(deps.db, input.accountId),
    openGamesForAccount(deps.db, input.accountId),
  );
  const challengers = await resolveChallengers(deps, command.challengers);
  const { game, players } = createGameInput(
    {
      // Local accounts report a bare username; remote ones carry "user@domain".
      host: { accountId: input.accountId, acct: input.accountAcct },
      theme: command.theme,
      playlistLength: command.playlistLength,
      challengers,
      now: deps.now(),
    },
    {
      pollDurationSec: deps.pollDurationSec,
      acceptanceWindowSec: deps.acceptanceWindowSec,
      id: deps.newGameId(),
    },
  );

  deps.db.transaction(() => {
    insertGame(deps.db, { ...game, status: "CREATED" }, input.statusId, replyVisibility(input));
    for (const p of players) insertPlayer(deps.db, game.id, p);
  })();
  return game.id;
}

/** Challenger accounts may live on this or a remote instance — federated polls count. */
async function resolveChallengers(deps: HandlerDeps, accts: string[]): Promise<Challenger[]> {
  const challengers: Challenger[] = [];
  for (const acct of accts) {
    try {
      const info = await deps.lookup(acct);
      challengers.push({ accountId: info.id, acct: info.acct });
    } catch (err) {
      if (err instanceof MastodonApiError) throw new ValidationError(m().challengerLookupFailed(acct));
      throw err;
    }
  }
  return challengers;
}

async function reportCreationFailure(input: CommandInput, deps: HandlerDeps, err: unknown): Promise<Handled> {
  deps.logger?.warn(
    {
      statusId: input.statusId,
      err: errorMessage(err),
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, LOGGED_STACK_LINES) : undefined,
    },
    "game creation failed",
  );
  const playerFacing = err instanceof ValidationError || err instanceof RateLimitedError;
  return replyWithError(input, deps, playerFacing ? err.message : m().unexpectedCreateError());
}

/** Post the thread root unless it exists; null when the game left CREATED meanwhile. */
async function ensureThreadRoot(
  deps: HandlerDeps,
  game: Game,
  players: Player[],
  mention: CreationMention,
): Promise<Game | null> {
  if (game.threadRootId) return game;
  const threadRootId = await reply(
    deps,
    mention.statusId,
    m().gameCreated(game.theme, game.playlistLength, players.length, game.acceptanceDeadline ?? "", game.id),
    mention.visibility,
    { idempotencyKey: `pb:v1:creation:${mention.statusId}:root` },
  );
  const rooted = { ...game, threadRootId, updatedAt: deps.now().toISOString() };
  return saveGame(deps.db, rooted, "CREATED") ? rooted : null;
}

async function sendPendingInvites(deps: HandlerDeps, game: Game, players: Player[]): Promise<void> {
  const hostAcct = players.find((p) => p.role === "host")?.acct ?? UNKNOWN_HOST_ACCT;
  const invitation = m().inviteDm(game.theme, hostAcct, game.playlistLength, game.acceptanceDeadline ?? "");
  for (const invitee of unsentInvites(deps.db, game.id)) {
    await dm(deps, invitee.accountId, invitation, invitee.acct, {
      idempotencyKey: `pb:v1:creation:${game.id}:invite:${invitee.accountId}`,
    });
    markInviteSent(deps.db, game.id, invitee.accountId, deps.now());
  }
}
