import { NON_TERMINAL_STATUS_SQL, type Db } from "../db/index.js";
import { MastodonApiError, RateLimitError } from "../mastodon/client.js";
import type { MastodonClient, RequestOptions } from "../mastodon/client.js";
import type { Logger } from "../logger.js";
import { classifyNotification, type RawNotification } from "../mastodon/notifications.js";
import { sourceStatuses } from "../game/stateMachine.js";
import {
  htmlToText,
  parseCreateCommand,
  parseDmReply,
  parseStatusCommand,
} from "./commands.js";
import {
  acceptInvite,
  createGameInput,
  declineInvite,
  finalizeCollection,
  startRound,
  submitTune,
  ValidationError,
} from "../game/engine.js";
import { assertCanCreateGame, RateLimitedError } from "../game/rateLimit.js";
import type { Game, Player } from "../game/types.js";
import {
  insertGame,
  insertPlayer,
  clearNotificationFailure,
  recordNotificationFailure,
  insertTune,
  lastHostedCreation,
  loadGame,
  loadPlayers,
  loadRound,
  loadTunes,
  openGamesForAccount,
  roundMeta,
  saveGame,
  savePlayer,
} from "../game/store.js";
import { emitRound } from "../scheduler/roundState.js";
import { dm } from "../mastodon/dm.js";
import { extractVideoId } from "../youtube/normalize.js";
import type { BattlePlaylistPublisher } from "../youtube/playlist.js";
import { assertPostLength } from "../templates/truncate.js";
import { m } from "../i18n/index.js";
import { voidOpenGame } from "./closure.js";

export type HandlerDeps = {
  db: Db;
  client: MastodonClient;
  botAcct: string;
  instanceDomain: string;
  pollDurationSec: number;
  acceptanceWindowSec: number;
  submissionWindowSec: number;
  creationCooldownSec: number;
  maxGamesPerPlayer: number;
  lookup: (acct: string) => Promise<{ id: string; acct: string; username: string }>;
  resolveTitle: (videoId: string) => Promise<{ videoId: string; title: string; author: string | null; canonicalUrl: string }>;
  /** Live availability check for a video (never reads the title cache). */
  checkAvailable: (videoId: string) => Promise<boolean>;
  /**
   * Publishes the battle's round-winning tunes as one shareable link — a real
   * YT Music playlist when the bot account is configured, otherwise an
   * anonymous YouTube queue — or null when nothing could be published.
   * Best-effort by contract: it never throws, so the finale posts regardless.
   */
  publishBattlePlaylist: BattlePlaylistPublisher;
  /** Replacement window for unavailable round tunes (v1.1 1.4). */
  replacementGraceMin: number;
  now: () => Date;
  newGameId: () => string;
  /**
   * Fast path for poll-expiry notifications, injected by the runtime so the
   * handler layer never imports the scheduler (keeps the dependency graph
   * acyclic). When unset, the scheduler's periodic sweep still resolves the poll.
   */
  onPollExpired?: (statusId: string | null) => Promise<void>;
  /**
   * Diagnostics sink for unexpected errors whose text must never reach a player
   * (oEmbed/SQLite internals). Optional so tests can omit it.
   */
  log?: (message: string, detail?: unknown) => void;
  /**
   * Structured leveled logger for live debugging (notification flow, sweeps).
   * Optional so tests can omit it.
   */
  logger?: Logger;
};

export type CommandInput = {
  accountId: string;
  accountAcct: string;
  statusId: string;
  content: string;
  inReplyToId: string | null;
  visibility?: "public" | "unlisted" | "private";
};

export type HandlerResult =
  | { handled: false; reason: string }
  | { handled: true; kind: string; detail?: unknown };

// ── outbound helpers ────────────────────────────────────────

async function reply(
  deps: HandlerDeps,
  inReplyToId: string,
  text: string,
  visibility: "public" | "unlisted" | "private" | "direct" = "public",
  options: RequestOptions = {},
): Promise<string> {
  assertPostLength(text);
  const status = await deps.client.post<{ id: string }>("/api/v1/statuses", {
    status: text,
    in_reply_to_id: inReplyToId,
    visibility,
  }, options);
  return status.id;
}

function dmTo(
  deps: HandlerDeps,
  accountId: string,
  text: string,
  fallbackAcct?: string,
  options: RequestOptions = {},
): Promise<string> {
  return dm(deps.db, deps.client, accountId, text, fallbackAcct, options, deps.instanceDomain);
}

async function resumeCreation(
  input: CommandInput,
  deps: HandlerDeps,
  gameId: string,
  visibility: "public" | "unlisted" | "private",
): Promise<HandlerResult> {
  let game = loadGame(deps.db, gameId);
  if (!game) throw new Error(`Creation game ${gameId} no longer exists`);
  if (game.status !== "CREATED") {
    return { handled: true, kind: "game_created", detail: game.id };
  }

  let rootReplyId = game.threadRootId;
  if (!rootReplyId) {
    const players = loadPlayers(deps.db, game.id);
    rootReplyId = await reply(
      deps,
      input.statusId,
      m().gameCreated(
        game.theme,
        game.playlistLength,
        players.length,
        game.acceptanceDeadline ?? "",
        game.id,
      ),
      visibility,
      { idempotencyKey: `pb:v1:creation:${input.statusId}:root` },
    );
    game = { ...game, threadRootId: rootReplyId, updatedAt: deps.now().toISOString() };
    if (!saveGame(deps.db, game, "CREATED")) {
      return { handled: true, kind: "game_created", detail: game.id };
    }
  }

  for (const player of loadPlayers(deps.db, game.id).filter((p) => p.inviteStatus === "pending")) {
    const sent = deps.db
      .prepare("SELECT invite_sent_at FROM players WHERE game_id = ? AND account_id = ?")
      .get(game.id, player.accountId) as { invite_sent_at: string | null } | undefined;
    if (sent?.invite_sent_at) continue;
    const hostAcct = loadPlayers(deps.db, game.id).find((p) => p.role === "host")?.acct ?? "?";
    const inviteText = m().inviteDm(
      game.theme,
      hostAcct,
      game.playlistLength,
      game.acceptanceDeadline ?? "",
    );
    await dmTo(
      deps,
      player.accountId,
      inviteText,
      player.acct,
      { idempotencyKey: `pb:v1:creation:${game.id}:invite:${player.accountId}` },
    );
    deps.db
      .prepare("UPDATE players SET invite_sent_at = ? WHERE game_id = ? AND account_id = ?")
      .run(deps.now().toISOString(), game.id, player.accountId);
  }

  game = loadGame(deps.db, game.id)!;
  if (game.status === "CREATED") {
    saveGame(deps.db, { ...game, status: "INVITED", updatedAt: deps.now().toISOString() }, "CREATED");
  }
  return { handled: true, kind: "game_created", detail: game.id };
}

// ── public command handler ──────────────────────────────────

export async function handlePublicCommand(input: CommandInput, deps: HandlerDeps): Promise<HandlerResult> {
  const text = htmlToText(input.content);
  const replyVisibility = input.visibility ?? "public";
  const existingCreation = deps.db
    .prepare("SELECT id, creation_visibility FROM games WHERE creation_status_id = ?")
    .get(input.statusId) as { id: string; creation_visibility: string } | undefined;
  if (existingCreation) {
    if (existingCreation.creation_visibility === "private") {
      const message = m().errPrivateCreate();
      await reply(deps, input.statusId, message, replyVisibility);
      return { handled: true, kind: "error", detail: message };
    }
    return resumeCreation(input, deps, existingCreation.id, replyVisibility);
  }

  if (parseStatusCommand(text, deps.botAcct)) {
    return handleStatus(input, deps, text);
  }

  const cmd = parseCreateCommand(text, deps.botAcct);
  if (cmd === null) return { handled: false, reason: "not a command" };

  if ("error" in cmd) {
    await reply(deps, input.statusId, cmd.error, replyVisibility);
    return { handled: true, kind: "error", detail: cmd.error };
  }

  if (replyVisibility === "private") {
    const message = m().errPrivateCreate();
    await reply(deps, input.statusId, message, replyVisibility);
    return { handled: true, kind: "error", detail: message };
  }

  let persisted = false;
  try {
    // Rate limits — open games + last hosted creation for this account only
    assertCanCreateGame(
      { creationCooldownSec: deps.creationCooldownSec, maxGamesPerPlayer: deps.maxGamesPerPlayer },
      deps.now(),
      lastHostedCreation(deps.db, input.accountId),
      openGamesForAccount(deps.db, input.accountId),
    );

    // Resolve challenger accounts (same or remote instance — federated polls count)
    const challengers = [];
    for (const acct of cmd.challengers) {
      const info = await deps.lookup(acct);
      challengers.push({ accountId: info.id, acct: info.acct });
    }

    const host = {
      accountId: input.accountId,
      // Local accounts report a bare username; remote ones carry "user@domain".
      acct: input.accountAcct,
    };

    const { game, players } = createGameInput(
      { host, theme: cmd.theme, playlistLength: cmd.playlistLength, challengers, now: deps.now() },
      {
        pollDurationSec: deps.pollDurationSec,
        acceptanceWindowSec: deps.acceptanceWindowSec,
        id: deps.newGameId(),
      },
    );

    const deadline = game.acceptanceDeadline ?? "";
    const createdGame: Game = { ...game, status: "CREATED", threadRootId: null };
    deps.db.transaction(() => {
      insertGame(deps.db, createdGame, input.statusId, replyVisibility);
      for (const p of players) insertPlayer(deps.db, game.id, p);
    })();
    persisted = true;

    const rootReplyId = await reply(
      deps,
      input.statusId,
      m().gameCreated(game.theme, game.playlistLength, players.length, deadline, game.id),
      replyVisibility,
      { idempotencyKey: `pb:v1:creation:${input.statusId}:root` },
    );
    if (!saveGame(deps.db, { ...createdGame, threadRootId: rootReplyId }, "CREATED")) {
      return { handled: true, kind: "game_created", detail: createdGame.id };
    }

    for (const p of players.filter((x) => x.inviteStatus === "pending")) {
      const hostAcct = players.find((x) => x.role === "host")?.acct ?? "?";
      const inviteText = m().inviteDm(game.theme, hostAcct, game.playlistLength, deadline);
      await dmTo(
        deps,
        p.accountId,
        inviteText,
        p.acct,
        { idempotencyKey: `pb:v1:creation:${game.id}:invite:${p.accountId}` },
      );
      deps.db
        .prepare("UPDATE players SET invite_sent_at = ? WHERE game_id = ? AND account_id = ?")
        .run(deps.now().toISOString(), game.id, p.accountId);
    }

    saveGame(
      deps.db,
      {
        ...createdGame,
        status: "INVITED",
        threadRootId: rootReplyId,
        updatedAt: deps.now().toISOString(),
      },
      "CREATED",
    );

    return { handled: true, kind: "game_created", detail: game.id };
  } catch (err) {
    if (persisted) {
      deps.log?.("game creation side effect failed; retrying notification", {
        statusId: input.statusId,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    const msg =
      err instanceof ValidationError || err instanceof RateLimitedError
        ? err.message
        : m().unexpectedCreateError();
    await reply(deps, input.statusId, msg, replyVisibility);
    return { handled: true, kind: "error", detail: msg };
  }
}

async function handleStatus(input: CommandInput, deps: HandlerDeps, _text: string): Promise<HandlerResult> {
  const replyVisibility = input.visibility ?? "public";
  // Find most recent open game involving this account
  const row = deps.db
    .prepare(
      `SELECT g.id FROM games g JOIN players p ON p.game_id = g.id
       WHERE p.account_id = ? AND g.status ${NON_TERMINAL_STATUS_SQL}
       ORDER BY g.created_at DESC LIMIT 1`,
    )
    .get(input.accountId) as { id: string } | undefined;

  if (!row) {
    await reply(deps, input.statusId, m().statusNone(), replyVisibility);
    return { handled: true, kind: "status", detail: "none" };
  }

  const game = loadGame(deps.db, row.id)!;
  const players = loadPlayers(deps.db, row.id);
  const statusLabel = m().gameStatus(game.status, game.currentRound, game.playlistLength);
  const playersStr = players.map((p) => `@${p.acct} ${m().statusPoints(p.points)}`).join(", ");
  const lines = [
    m().statusLine(m().statusLabelStatus(), statusLabel),
    m().statusLine(m().statusLabelTheme(), game.theme),
    m().statusLine(m().statusLabelPot(), String(game.pot)),
    m().statusLine(m().statusLabelPlayers(), playersStr),
    m().statusLine(m().statusLabelGameId(), game.id),
  ];
  await reply(deps, input.statusId, lines.join("\n"), replyVisibility);
  return { handled: true, kind: "status", detail: game.id };
}

// ── DM handler ──────────────────────────────────────────────

export async function handleDm(input: CommandInput, deps: HandlerDeps): Promise<HandlerResult> {
  const text = htmlToText(input.content);
  const reply_ = parseDmReply(text);

  if (reply_.kind === "accept" || reply_.kind === "decline") {
    return handleInviteResponse(input, deps, reply_.kind);
  }

  if (reply_.kind === "links") {
    return handleLinkSubmission(input, deps, reply_.urls);
  }

  if (reply_.kind === "cancel") {
    return handleCancel(input, deps);
  }

  if (reply_.kind === "replace") {
    return handleReplace(input, deps, reply_.position, reply_.url);
  }

  deps.logger?.debug(
    { accountId: input.accountId, text: text.slice(0, 200) },
    "unrecognized DM text",
  );
  await dmTo(
    deps,
    input.accountId,
    m().unknownDm(deps.botAcct),
    input.accountAcct,
  );
  return { handled: true, kind: "unknown" };
}

/**
 * RULES §4/§6: the host voids an open game by DM — no champion, no pot, scores
 * stay as historical record. The state machine owns which states may close
 * (`sourceStatuses("CANCEL")`), so anything else reads as "nothing to cancel".
 */
async function handleCancel(input: CommandInput, deps: HandlerDeps): Promise<HandlerResult> {
  const cancellable = sourceStatuses("CANCEL");
  const row = deps.db
    .prepare(
      `SELECT g.id FROM games g JOIN players p ON p.game_id = g.id
       WHERE p.account_id = ? AND p.role = 'host'
         AND g.status IN (${cancellable.map(() => "?").join(", ")})
       ORDER BY g.created_at DESC LIMIT 1`,
    )
    .get(input.accountId, ...cancellable) as { id: string } | undefined;

  const cancelled = row ? await voidOpenGame(deps, row.id, "CANCEL") : null;
  if (!cancelled) {
    await dmTo(deps, input.accountId, m().cancelNothing(), input.accountAcct);
    return { handled: true, kind: "cancel_rejected", detail: "no cancellable game" };
  }

  await dmTo(deps, input.accountId, m().cancelDone(cancelled.theme), input.accountAcct);
  return { handled: true, kind: "game_cancelled", detail: cancelled.id };
}

async function findInvitationGame(
  deps: HandlerDeps,
  accountId: string,
): Promise<{ game: Game; players: Player[] } | null> {
  // Pending invites remain valid during INVITED and after the first accept (COLLECTING),
  // until the acceptance window closes — checked in-SQL so a DM landing after
  // the deadline (but before the 60s sweep expires the invite) can't sneak in.
  const row = deps.db
    .prepare(
      `SELECT g.id FROM games g JOIN players p ON p.game_id = g.id
       WHERE p.account_id = ? AND p.invite_status = 'pending' AND g.status IN ('INVITED', 'COLLECTING')
         AND (g.acceptance_deadline IS NULL OR g.acceptance_deadline > ?)
       ORDER BY g.created_at DESC LIMIT 1`,
    )
    .get(accountId, deps.now().toISOString()) as { id: string } | undefined;
  if (!row) return null;
  return { game: loadGame(deps.db, row.id)!, players: loadPlayers(deps.db, row.id) };
}

async function handleInviteResponse(
  input: CommandInput,
  deps: HandlerDeps,
  decision: "accept" | "decline",
): Promise<HandlerResult> {
  const found = await findInvitationGame(deps, input.accountId);
  if (!found) {
    await dmTo(deps, input.accountId, m().noInvitation(), input.accountAcct);
    return { handled: true, kind: "no_invitation" };
  }

    const { game, players } = found;
    try {
      if (decision === "accept") {
        const otherGames = openGamesForAccount(deps.db, input.accountId)
          .filter((open) => open.id !== game.id);
        if (otherGames.length >= deps.maxGamesPerPlayer) {
          throw new ValidationError(
            m().errConcurrentGames(otherGames.length + 1, deps.maxGamesPerPlayer),
          );
        }
      }
      const ts = deps.now().toISOString();
      const result =
        decision === "accept"
          ? acceptInvite(game, players, input.accountId, deps.now())
          : declineInvite(game, players, input.accountId);
      const firstAccept = "firstAccept" in result ? result.firstAccept : false;
      const submissionDeadline = firstAccept
        ? new Date(deps.now().getTime() + deps.submissionWindowSec * 1000).toISOString()
        : result.game.submissionDeadline;

      deps.db.transaction(() => {
        for (const p of result.players) savePlayer(deps.db, game.id, p);
        if (!saveGame(deps.db, { ...result.game, submissionDeadline, updatedAt: ts }, game.status)) {
          throw new Error("Game changed while processing invitation");
        }
      })();

      if (decision === "decline") {
        await dmTo(deps, input.accountId, m().declined());
        return { handled: true, kind: "declined" };
      }

      await dmTo(deps, input.accountId, m().youAreIn());

      if (firstAccept) {
        const fresh = loadPlayers(deps.db, game.id);
        const freshGame = loadGame(deps.db, game.id)!;
        for (const p of fresh.filter((x) => x.inviteStatus === "accepted")) {
          await dmTo(deps, p.accountId, m().submitFirst(freshGame.playlistLength));
        }
      }
      return { handled: true, kind: "accepted", detail: firstAccept ? "first" : "subsequent" };
    } catch (err) {
    const msg = err instanceof ValidationError ? err.message : m().invitationError();
    await dmTo(deps, input.accountId, msg);
    return { handled: true, kind: "error", detail: msg };
  }
}

async function handleLinkSubmission(
  input: CommandInput,
  deps: HandlerDeps,
  urls: string[],
): Promise<HandlerResult> {
  const selection = selectReplacementWindow(
    replacementWindows(deps, input.accountId),
    input.inReplyToId,
  );
  if (selection.ambiguous) {
    await dmTo(deps, input.accountId, m().errReplacementAmbiguous(), input.accountAcct);
    return { handled: true, kind: "replace_rejected", detail: "ambiguous replacement window" };
  }
  if (selection.window) {
    const result = await swapTune(
      input,
      deps,
      selection.window.game,
      selection.window.position,
      urls[0]!,
    );
    if (result.kind === "tune_replaced") {
      await emitRound(deps, selection.window.game.id, selection.window.position);
    }
    return result;
  }

  const game = findCollectingGame(deps, input.accountId);
  if (!game) {
    await dmTo(deps, input.accountId, m().noCollecting(), input.accountAcct);
    return { handled: true, kind: "no_collecting_game" };
  }

  const players = loadPlayers(deps.db, game.id);
  let tunes = loadTunes(deps.db, game.id);

  let accepted = 0;
  let lastError: string | null = null; // player-facing copy
  let lastDetail: string | null = null; // internal reason, for the handler result

  for (const url of urls) {
    const videoId = extractVideoId(url);
    if (!videoId) {
      lastError = m().notPlayable(url);
      lastDetail = "not playable";
      continue;
    }
    // Cheap guard so a video we already hold never costs an oEmbed call.
    if (tunes.some((t) => t.accountId === input.accountId && t.videoId === videoId)) {
      lastError = m().errVideoDup();
      lastDetail = "duplicate";
      continue;
    }

    try {
      const resolved = await deps.resolveTitle(videoId);
      // The engine owns the submission rules (status, player, capacity, dupes).
      const withTune = submitTune(game, players, tunes, input.accountId, resolved, m(), deps.now());
      const added = withTune[withTune.length - 1]!;
      insertTune(deps.db, game.id, added);
      tunes = loadTunes(deps.db, game.id);
      accepted += 1;
      const mine = tunes.filter((t) => t.accountId === input.accountId).length;
      const msg =
        mine >= game.playlistLength
          ? m().tuneAcceptedComplete(added.position, game.playlistLength, resolved.title)
          : m().tuneAcceptedMore(added.position, game.playlistLength, resolved.title, mine + 1);
      await dmTo(deps, input.accountId, msg);
    } catch (err) {
      if (err instanceof ValidationError) {
        lastError = err.message;
        lastDetail = err.message;
      } else {
        // Never DM internals (oEmbed/SQLite text): log them instead.
        lastError = m().resolveVideoError();
        lastDetail = err instanceof Error ? err.message : String(err);
        deps.log?.("tune submission failed", { videoId, err: lastDetail });
      }
    }
  }

  if (accepted > 0) {
    // Check if all players now complete → READY
    await maybeAdvanceToReady(deps, game.id);
    return { handled: true, kind: "tune_accepted", detail: { accepted, lastError: lastDetail } };
  }

  await dmTo(deps, input.accountId, lastError ?? m().linkRejected());
  return { handled: true, kind: "tune_rejected", detail: lastDetail };
}

/** The player's live submission game (COLLECTING), or null. */
function findCollectingGame(deps: HandlerDeps, accountId: string): Game | null {
  const row = deps.db
    .prepare(
      `SELECT g.id FROM games g JOIN players p ON p.game_id = g.id
       WHERE p.account_id = ? AND p.invite_status = 'accepted' AND g.status = 'COLLECTING'
         AND g.submission_deadline IS NOT NULL AND g.submission_deadline > ?
       ORDER BY g.created_at DESC LIMIT 1`,
    )
    .get(accountId, deps.now().toISOString()) as { id: string } | undefined;
  return row ? loadGame(deps.db, row.id) : null;
}

type ReplacementWindow = { game: Game; position: number; promptStatusId: string | null };

type ReplacementSelection = { window: ReplacementWindow | null; ambiguous: boolean };

function replacementWindows(deps: HandlerDeps, accountId: string): ReplacementWindow[] {
  const rows = deps.db
    .prepare(
      `SELECT g.id FROM games g JOIN players p ON p.game_id = g.id
       WHERE p.account_id = ? AND p.invite_status = 'accepted' AND g.status = 'ROUND'
       ORDER BY g.created_at ASC, g.id ASC`,
    )
    .all(accountId) as { id: string }[];
  const windows: ReplacementWindow[] = [];
  for (const { id } of rows) {
    const game = loadGame(deps.db, id);
    if (!game) continue;
    const round = loadRound(deps.db, game.id, game.currentRound);
    const meta = roundMeta(round);
    const deadline = meta.replacement?.deadline;
    if (round?.status !== "announced" || meta.publishing) continue;
    if (!deadline || deps.now().getTime() >= new Date(deadline).getTime()) continue;
    const tunes = loadTunes(deps.db, game.id);
    if (!tunes.some((t) => t.accountId === accountId && t.position === game.currentRound)) continue;
    windows.push({
      game,
      position: game.currentRound,
      promptStatusId: meta.replacement?.prompts?.[accountId] ?? null,
    });
  }
  return windows;
}

function selectReplacementWindow(
  windows: ReplacementWindow[],
  inReplyToId: string | null,
): ReplacementSelection {
  if (inReplyToId) {
    const matches = windows.filter((window) => window.promptStatusId === inReplyToId);
    return { window: matches.length === 1 ? matches[0]! : null, ambiguous: matches.length !== 1 };
  }
  return {
    window: windows.length === 1 ? windows[0]! : null,
    ambiguous: windows.length > 1,
  };
}

type SwapResult =
  | { handled: true; kind: "tune_replaced"; detail: { position: number; videoId: string } }
  | { handled: true; kind: "replace_rejected"; detail: string };

/** Swap the tune at `position` for the video in `url` (shared by both replace paths). */
async function swapTune(
  input: CommandInput,
  deps: HandlerDeps,
  game: Game,
  position: number,
  url: string,
): Promise<SwapResult> {
  const videoId = extractVideoId(url);
  if (!videoId) {
    await dmTo(deps, input.accountId, m().notPlayable(url), input.accountAcct);
    return { handled: true, kind: "replace_rejected", detail: "not playable" };
  }

  const mine = loadTunes(deps.db, game.id).filter((t) => t.accountId === input.accountId);
  if (!mine.some((t) => t.position === position)) {
    await dmTo(deps, input.accountId, m().errReplaceMissing(position), input.accountAcct);
    return { handled: true, kind: "replace_rejected", detail: "no tune at position" };
  }
  if (mine.some((t) => t.videoId === videoId && t.position !== position)) {
    await dmTo(deps, input.accountId, m().alreadyInPlaylist(), input.accountAcct);
    return { handled: true, kind: "replace_rejected", detail: "duplicate" };
  }

  try {
    const resolved = await deps.resolveTitle(videoId);
    const currentGame = loadGame(deps.db, game.id);
    const currentRound = currentGame?.status === "ROUND" && currentGame.currentRound === position
      ? loadRound(deps.db, game.id, position)
      : undefined;
    const replacementStillOpen = currentRound?.status === "announced" &&
      !roundMeta(currentRound).publishing &&
      !!roundMeta(currentRound).replacement?.deadline &&
      deps.now().getTime() < new Date(roundMeta(currentRound).replacement!.deadline!).getTime();
    const collectingStillOpen = currentGame?.status === "COLLECTING" &&
      !!currentGame.submissionDeadline &&
      deps.now().getTime() < new Date(currentGame.submissionDeadline).getTime();
    if (!replacementStillOpen && !collectingStillOpen) {
      await dmTo(deps, input.accountId, m().errNotCollecting(), input.accountAcct);
      return { handled: true, kind: "replace_rejected", detail: "window closed" };
    }
    deps.db
      .prepare(
        `UPDATE tunes SET video_id = ?, title = ?, canonical_url = ?
         WHERE game_id = ? AND account_id = ? AND position = ?`,
      )
      .run(resolved.videoId, resolved.title, resolved.canonicalUrl, game.id, input.accountId, position);
    await dmTo(
      deps,
      input.accountId,
      m().tuneReplaced(position, game.playlistLength, resolved.title),
      input.accountAcct,
    );
    return { handled: true, kind: "tune_replaced", detail: { position, videoId: resolved.videoId } };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log?.("tune replacement failed", { videoId, position, err: detail });
    await dmTo(deps, input.accountId, m().resolveVideoError(), input.accountAcct);
    return { handled: true, kind: "replace_rejected", detail };
  }
}

/**
 * v1.1 1.6: `replace <n> <url>` — swap tune n. While the game is collecting,
 * the last write wins before the submission deadline; while a round's
 * replacement window is open (v1.1 1.4) the same command targets the current
 * round's tune.
 */
async function handleReplace(
  input: CommandInput,
  deps: HandlerDeps,
  position: number,
  url: string,
): Promise<HandlerResult> {
  const selection = selectReplacementWindow(
    replacementWindows(deps, input.accountId),
    input.inReplyToId,
  );
  if (selection.ambiguous) {
    await dmTo(deps, input.accountId, m().errReplacementAmbiguous(), input.accountAcct);
    return { handled: true, kind: "replace_rejected", detail: "ambiguous replacement window" };
  }
  if (selection.window) {
    if (position !== selection.window.position) {
      await dmTo(
        deps,
        input.accountId,
        m().errReplaceWindowOnly(selection.window.position),
        input.accountAcct,
      );
      return { handled: true, kind: "replace_rejected", detail: "position outside the open window" };
    }
    const result = await swapTune(input, deps, selection.window.game, position, url);
    if (result.kind === "tune_replaced") {
      await emitRound(deps, selection.window.game.id, position);
    }
    return result;
  }

  const collecting = findCollectingGame(deps, input.accountId);
  if (collecting) {
    if (position < 1 || position > collecting.playlistLength) {
      await dmTo(
        deps,
        input.accountId,
        m().errReplacePosition(collecting.playlistLength),
        input.accountAcct,
      );
      return { handled: true, kind: "replace_rejected", detail: "position out of range" };
    }
    return swapTune(input, deps, collecting, position, url);
  }

  await dmTo(deps, input.accountId, m().errNotCollecting(), input.accountAcct);
  return { handled: true, kind: "replace_rejected", detail: "not collecting" };
}

async function maybeAdvanceToReady(deps: HandlerDeps, gameId: string): Promise<boolean> {
  const game = loadGame(deps.db, gameId)!;
  const players = loadPlayers(deps.db, gameId).filter((p) => p.inviteStatus === "accepted");
  const tunes = loadTunes(deps.db, gameId);
  const allComplete = players.every(
    (p) => tunes.filter((t) => t.accountId === p.accountId).length >= game.playlistLength,
  );
  if (!allComplete || players.length < 2) return false;

  const finalized = finalizeCollection(
    game,
    players,
    tunes,
    game.playlistLength,
    deps.now(),
  );
  const finalizedSaved = deps.db.transaction(() => {
    if (!saveGame(deps.db, finalized.game, "COLLECTING")) return false;
    for (const p of finalized.players) savePlayer(deps.db, gameId, p);
    return true;
  })();
  if (!finalizedSaved) return false;

  if (finalized.outcome !== "ready") return false;

  // READY → start round 1
  const readyGame = loadGame(deps.db, gameId)!;
  const started = startRound(readyGame, 1, deps.now());
  if (!saveGame(deps.db, started, "READY")) return false;

  // Post duel announcement on creation thread
  const rootId = started.threadRootId ?? started.id;
  const freshPlayers = loadPlayers(deps.db, gameId);
  const playingCount = freshPlayers.filter((p) => p.inviteStatus === "accepted").length;
  const text = m().duelStart(started.theme, started.playlistLength, playingCount);
  await reply(deps, rootId, text);

  // Emit Round 1 posts (announce → tunes → poll), with auto-tie short-circuit
  await emitRound(deps, gameId, 1);
  return true;
}

// ── notification ingestion ──────────────────────────────────

const POISON_ATTEMPTS = 3;

function isRateLimitNotificationError(err: unknown): boolean {
  return err instanceof RateLimitError || (err instanceof MastodonApiError && err.status === 429);
}

function isRetryableNotificationError(err: unknown): boolean {
  if (err instanceof ValidationError) return false;
  if (isRateLimitNotificationError(err)) return true;
  if (err instanceof RateLimitedError || err instanceof MastodonApiError) {
    return err instanceof RateLimitedError || err.status === 408 || err.status >= 500;
  }
  return true;
}

export async function processNotification(n: RawNotification, deps: HandlerDeps): Promise<void> {
  const classified = classifyNotification(n, deps.botAcct);
  if (!classified) {
    deps.logger?.debug(
      { notificationId: n.id, type: n.type },
      "notification skipped: not addressed to bot",
    );
    return;
  }

  // Claim before handling: an overlapping run sees the row and skips, so one
  // notification can never be handled twice. Released on failure so the next
  // poll retries it — up to POISON_ATTEMPTS times; beyond that the claim is
  // marked terminal ('error') so a permanently failing notification cannot
  // wedge the cursor. Boot clears pending claims left by a crashed process.
  const claim = deps.db
    .prepare("INSERT OR IGNORE INTO processed_notifications (notification_id, processed_at) VALUES (?, '')")
    .run(n.id);
  if (claim.changes === 0) {
    deps.logger?.debug(
      { notificationId: n.id, kind: classified.kind },
      "notification skipped: already claimed or processed",
    );
    return;
  }

  deps.logger?.debug(
    {
      notificationId: n.id,
      kind: classified.kind,
      ...(classified.kind !== "poll_expired" ? { from: classified.accountAcct } : {}),
    },
    "notification claimed",
  );

  try {
    let result: HandlerResult;
    if (classified.kind === "public_command") {
      result = await handlePublicCommand(
        {
          accountId: classified.accountId,
          accountAcct: classified.accountAcct,
          statusId: classified.statusId,
          content: classified.content,
          inReplyToId: classified.inReplyToId,
          visibility: classified.visibility,
        },
        deps,
      );
    } else if (classified.kind === "dm") {
      result = await handleDm(
        {
          accountId: classified.accountId,
          accountAcct: classified.accountAcct,
          statusId: classified.statusId,
          content: classified.content,
          inReplyToId: classified.inReplyToId,
        },
        deps,
      );
    } else {
      await deps.onPollExpired?.(classified.statusId);
      result = { handled: true, kind: "poll_expired" };
    }

    deps.logger?.info(
      {
        notificationId: n.id,
        kind: classified.kind,
        ...(classified.kind !== "poll_expired" ? { from: classified.accountAcct } : {}),
        result,
      },
      "notification handled",
    );

    clearNotificationFailure(deps.db, n.id);
    deps.db
      .prepare("UPDATE processed_notifications SET processed_at = ? WHERE notification_id = ?")
      .run(deps.now().toISOString(), n.id);
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    const rateLimited = isRateLimitNotificationError(err);
    let attemptCount = 1;
    if (rateLimited) {
      deps.db.prepare("DELETE FROM claim_attempts WHERE notification_id = ?").run(n.id);
    } else {
      const attempts = deps.db
        .prepare(
          `INSERT INTO claim_attempts (notification_id, attempts) VALUES (?, 1)
           ON CONFLICT(notification_id) DO UPDATE SET attempts = attempts + 1
           RETURNING attempts`,
        )
        .get(n.id) as { attempts: number } | undefined;
      attemptCount = attempts?.attempts ?? 1;
    }
    const deadLettered = !isRetryableNotificationError(err) ||
      (attemptCount >= POISON_ATTEMPTS && !rateLimited);
    const nextAttemptAt = rateLimited && err instanceof RateLimitError
      ? new Date(err.resetAt * 1000).toISOString()
      : null;
    recordNotificationFailure(
      deps.db,
      n.id,
      attemptCount,
      errorText,
      nextAttemptAt,
      deadLettered ? deps.now().toISOString() : null,
    );
    if (deadLettered) {
      deps.db
        .prepare("UPDATE processed_notifications SET processed_at = 'error', attempts = ? WHERE notification_id = ?")
        .run(attemptCount, n.id);
      deps.log?.("notification moved to dead letter", {
        notificationId: n.id,
        attempts: attemptCount,
        err: errorText,
      });
      deps.logger?.error(
        { notificationId: n.id, kind: classified.kind, attempts: attemptCount, err: errorText },
        "notification dead-lettered",
      );
      return;
    }
    deps.logger?.warn(
      {
        notificationId: n.id,
        kind: classified.kind,
        attempts: attemptCount,
        rateLimited,
        err: errorText,
      },
      "notification failed; will retry",
    );
    deps.db.prepare("DELETE FROM processed_notifications WHERE notification_id = ?").run(n.id);
    throw err;
  }
}

// ── notification ingestion ──────────────────────────────────
