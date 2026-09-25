import { NON_TERMINAL_STATUS_SQL, type Db } from "../db/index.js";
import { MastodonApiError, RateLimitError } from "../mastodon/client.js";
import type { MastodonClient, RequestOptions } from "../mastodon/client.js";
import type { Logger } from "../logger.js";
import { classifyNotification, type RawNotification } from "../mastodon/notifications.js";
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
import type { Game } from "../game/types.js";
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
  saveGameState,
} from "../game/store.js";
import { emitRound } from "../scheduler/roundState.js";
import { dm } from "../mastodon/dm.js";
import { extractVideoId } from "../youtube/normalize.js";
import type { ResolvedTune } from "../youtube/oembed.js";
import type { BattlePlaylistPublisher } from "../youtube/playlist.js";
import { assertPostLength } from "../templates/truncate.js";
import { m } from "../i18n/index.js";
import { CLOSURES, voidOpenGame } from "./closure.js";

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
  lookup: (acct: string) => Promise<{ id: string; acct: string }>;
  resolveTitle: (videoId: string) => Promise<ResolvedTune>;
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
   * Structured logger. Unexpected errors whose text must never reach a player
   * (oEmbed/SQLite internals) are logged here instead. Optional so tests can omit it.
   */
  logger?: Logger;
};

type Visibility = "public" | "unlisted" | "private";

export type CommandInput = {
  accountId: string;
  accountAcct: string;
  statusId: string;
  content: string;
  inReplyToId: string | null;
  visibility?: Visibility;
};

type Handled = { handled: true; kind: string; detail?: unknown };

export type HandlerResult = { handled: false; reason: string } | Handled;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function reply(
  deps: HandlerDeps,
  inReplyToId: string,
  text: string,
  visibility: Visibility = "public",
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
  visibility: Visibility,
): Promise<void> {
  let game = loadGame(deps.db, gameId);
  if (game?.status !== "CREATED") return;
  const players = loadPlayers(deps.db, gameId);
  const deadline = game.acceptanceDeadline ?? "";

  if (!game.threadRootId) {
    const threadRootId = await reply(
      deps,
      creationStatusId,
      m().gameCreated(game.theme, game.playlistLength, players.length, deadline, game.id),
      visibility,
      { idempotencyKey: `pb:v1:creation:${creationStatusId}:root` },
    );
    game = { ...game, threadRootId, updatedAt: deps.now().toISOString() };
    if (!saveGame(deps.db, game, "CREATED")) return;
  }

  const hostAcct = players.find((p) => p.role === "host")?.acct ?? "?";
  const unsent = deps.db
    .prepare(
      `SELECT account_id, acct FROM players
       WHERE game_id = ? AND invite_status = 'pending' AND invite_sent_at IS NULL ORDER BY rowid`,
    )
    .all(game.id) as { account_id: string; acct: string }[];
  for (const p of unsent) {
    await dm(
      deps,
      p.account_id,
      m().inviteDm(game.theme, hostAcct, game.playlistLength, deadline),
      p.acct,
      { idempotencyKey: `pb:v1:creation:${game.id}:invite:${p.account_id}` },
    );
    deps.db
      .prepare("UPDATE players SET invite_sent_at = ? WHERE game_id = ? AND account_id = ?")
      .run(deps.now().toISOString(), game.id, p.account_id);
  }

  saveGame(deps.db, { ...game, status: "INVITED", updatedAt: deps.now().toISOString() }, "CREATED");
}

// ── public command handler ──────────────────────────────────

export async function handlePublicCommand(input: CommandInput, deps: HandlerDeps): Promise<HandlerResult> {
  const text = htmlToText(input.content);
  const replyVisibility = input.visibility ?? "public";
  const rejectPrivate = async (): Promise<HandlerResult> => {
    const message = m().errPrivateCreate();
    await reply(deps, input.statusId, message, replyVisibility);
    return { handled: true, kind: "error", detail: message };
  };

  const existingCreation = deps.db
    .prepare("SELECT id, creation_visibility FROM games WHERE creation_status_id = ?")
    .get(input.statusId) as { id: string; creation_visibility: string } | undefined;
  if (existingCreation) {
    if (existingCreation.creation_visibility === "private") return rejectPrivate();
    await completeCreation(deps, existingCreation.id, input.statusId, replyVisibility);
    return { handled: true, kind: "game_created", detail: existingCreation.id };
  }

  if (parseStatusCommand(text, deps.botAcct)) {
    return handleStatus(input, deps);
  }

  const cmd = parseCreateCommand(text, deps.botAcct, deps.instanceDomain);
  if (cmd === null) return { handled: false, reason: "not a command" };

  if ("error" in cmd) {
    await reply(deps, input.statusId, cmd.error, replyVisibility);
    return { handled: true, kind: "error", detail: cmd.error };
  }

  if (replyVisibility === "private") return rejectPrivate();

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
      try {
        const info = await deps.lookup(acct);
        challengers.push({ accountId: info.id, acct: info.acct });
      } catch (err) {
        if (err instanceof MastodonApiError) {
          throw new ValidationError(m().challengerLookupFailed(acct));
        }
        throw err;
      }
    }

    const { game, players } = createGameInput(
      {
        // Local accounts report a bare username; remote ones carry "user@domain".
        host: { accountId: input.accountId, acct: input.accountAcct },
        theme: cmd.theme,
        playlistLength: cmd.playlistLength,
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
      insertGame(deps.db, { ...game, status: "CREATED" }, input.statusId, replyVisibility);
      for (const p of players) insertPlayer(deps.db, game.id, p);
    })();
    persisted = true;

    await completeCreation(deps, game.id, input.statusId, replyVisibility);
    return { handled: true, kind: "game_created", detail: game.id };
  } catch (err) {
    if (persisted) {
      deps.logger?.warn(
        { statusId: input.statusId, err: errorText(err) },
        "game creation side effect failed; retrying notification",
      );
      throw err;
    }
    deps.logger?.warn(
      {
        statusId: input.statusId,
        err: errorText(err),
        stack: err instanceof Error ? err.stack?.split("\n").slice(0, 5) : undefined,
      },
      "game creation failed",
    );
    const msg =
      err instanceof ValidationError || err instanceof RateLimitedError
        ? err.message
        : m().unexpectedCreateError();
    await reply(deps, input.statusId, msg, replyVisibility);
    return { handled: true, kind: "error", detail: msg };
  }
}

async function handleStatus(input: CommandInput, deps: HandlerDeps): Promise<HandlerResult> {
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
    `${m().statusLabelStatus()}: ${statusLabel}`,
    `${m().statusLabelTheme()}: ${game.theme}`,
    `${m().statusLabelPot()}: ${game.pot}`,
    `${m().statusLabelPlayers()}: ${playersStr}`,
    `${m().statusLabelGameId()}: ${game.id}`,
  ];
  await reply(deps, input.statusId, lines.join("\n"), replyVisibility);
  return { handled: true, kind: "status", detail: game.id };
}

// ── DM handler ──────────────────────────────────────────────

export async function handleDm(input: CommandInput, deps: HandlerDeps): Promise<HandlerResult> {
  const text = htmlToText(input.content);
  const parsed = parseDmReply(text);

  switch (parsed.kind) {
    case "accept":
    case "decline":
      return handleInviteResponse(input, deps, parsed.kind);
    case "links":
      return handleLinkSubmission(input, deps, parsed.urls);
    case "cancel":
      return handleCancel(input, deps);
    case "replace":
      return handleReplace(input, deps, parsed.position, parsed.url);
  }

  deps.logger?.debug(
    { accountId: input.accountId, text: text.slice(0, 200) },
    "unrecognized DM text",
  );
  await dm(deps, input.accountId, m().unknownDm(deps.botAcct), input.accountAcct);
  return { handled: true, kind: "unknown" };
}

/**
 * RULES §4/§6: the host voids an open game by DM — no champion, no pot, scores
 * stay as historical record. `CLOSURES.CANCEL` owns which states may close, so
 * anything else reads as "nothing to cancel".
 */
async function handleCancel(input: CommandInput, deps: HandlerDeps): Promise<HandlerResult> {
  const cancellable = CLOSURES.CANCEL.from;
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
    await dm(deps, input.accountId, m().cancelNothing(), input.accountAcct);
    return { handled: true, kind: "cancel_rejected", detail: "no cancellable game" };
  }

  await dm(deps, input.accountId, m().cancelDone(cancelled.theme), input.accountAcct);
  return { handled: true, kind: "game_cancelled", detail: cancelled.id };
}

async function handleInviteResponse(
  input: CommandInput,
  deps: HandlerDeps,
  decision: "accept" | "decline",
): Promise<HandlerResult> {
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
    .get(input.accountId, deps.now().toISOString()) as { id: string } | undefined;
  if (!row) {
    await dm(deps, input.accountId, m().noInvitation(), input.accountAcct);
    return { handled: true, kind: "no_invitation" };
  }

  const game = loadGame(deps.db, row.id)!;
  const players = loadPlayers(deps.db, row.id);
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
    const result =
      decision === "accept"
        ? acceptInvite(game, players, input.accountId, deps.now())
        : declineInvite(game, players, input.accountId);
    const firstAccept = "firstAccept" in result && result.firstAccept;
    const submissionDeadline = firstAccept
      ? new Date(deps.now().getTime() + deps.submissionWindowSec * 1000).toISOString()
      : result.game.submissionDeadline;

    const updated = { ...result.game, submissionDeadline, updatedAt: deps.now().toISOString() };
    if (!saveGameState(deps.db, updated, result.players, game.status)) {
      throw new Error("Game changed while processing invitation");
    }

    if (decision === "decline") {
      await dm(deps, input.accountId, m().declined());
      return { handled: true, kind: "declined" };
    }

    await dm(deps, input.accountId, m().youAreIn());

    if (firstAccept) {
      // `result.players` is exactly what was just persisted, so the prompts go to
      // everyone now accepted without re-reading the table.
      for (const p of result.players.filter((x) => x.inviteStatus === "accepted")) {
        await dm(deps, p.accountId, m().submitFirst(game.playlistLength));
      }
    }
    return { handled: true, kind: "accepted", detail: firstAccept ? "first" : "subsequent" };
  } catch (err) {
    const msg = err instanceof ValidationError ? err.message : m().invitationError();
    await dm(deps, input.accountId, msg);
    return { handled: true, kind: "error", detail: msg };
  }
}

async function handleLinkSubmission(
  input: CommandInput,
  deps: HandlerDeps,
  urls: string[],
): Promise<HandlerResult> {
  const replaced = await replaceInWindow(input, deps, urls[0]!);
  if (replaced) return replaced;

  const game = findCollectingGame(deps, input.accountId);
  if (!game) {
    await dm(deps, input.accountId, m().noCollecting(), input.accountAcct);
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
      // The engine's array is this player's authoritative playlist; re-reading it
      // would only re-fetch what is already here.
      tunes = withTune;
      accepted += 1;
      const mine = tunes.filter((t) => t.accountId === input.accountId).length;
      const msg =
        mine >= game.playlistLength
          ? m().tuneAcceptedComplete(added.position, game.playlistLength, resolved.title)
          : m().tuneAcceptedMore(added.position, game.playlistLength, resolved.title, mine + 1);
      await dm(deps, input.accountId, msg);
    } catch (err) {
      if (err instanceof ValidationError) {
        lastError = err.message;
        lastDetail = err.message;
      } else {
        // Never DM internals (oEmbed/SQLite text): log them instead.
        lastError = m().resolveVideoError();
        lastDetail = errorText(err);
        deps.logger?.warn({ videoId, err: lastDetail }, "tune submission failed");
      }
    }
  }

  if (accepted > 0) {
    // Check if all players now complete → READY
    await maybeAdvanceToReady(deps, game.id);
    return { handled: true, kind: "tune_accepted", detail: { accepted, lastError: lastDetail } };
  }

  await dm(deps, input.accountId, lastError ?? m().linkRejected());
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

/** The round's replacement deadline while its window is open (v1.1 1.4), else null. */
function openReplacementDeadline(deps: HandlerDeps, game: Game): string | null {
  const round = loadRound(deps.db, game.id, game.currentRound);
  const meta = roundMeta(round);
  const deadline = meta.replacement?.deadline;
  if (round?.status !== "announced" || meta.publishing || !deadline) return null;
  return deps.now().getTime() < new Date(deadline).getTime() ? deadline : null;
}

/**
 * Route a link into the player's open round-replacement window, if any.
 * Returns null when no window applies (the caller falls back to collection).
 * `position` (from `replace <n> <url>`) must name the window's round.
 */
async function replaceInWindow(
  input: CommandInput,
  deps: HandlerDeps,
  url: string,
  position?: number,
): Promise<HandlerResult | null> {
  const rows = deps.db
    .prepare(
      `SELECT g.id FROM games g JOIN players p ON p.game_id = g.id
       WHERE p.account_id = ? AND p.invite_status = 'accepted' AND g.status = 'ROUND'
       ORDER BY g.created_at ASC, g.id ASC`,
    )
    .all(input.accountId) as { id: string }[];
  const windows: { game: Game; promptStatusId: string | null }[] = [];
  for (const { id } of rows) {
    const game = loadGame(deps.db, id);
    if (!game || !openReplacementDeadline(deps, game)) continue;
    const tunes = loadTunes(deps.db, game.id);
    if (!tunes.some((t) => t.accountId === input.accountId && t.position === game.currentRound)) continue;
    const meta = roundMeta(loadRound(deps.db, game.id, game.currentRound));
    windows.push({ game, promptStatusId: meta.replacement?.prompts?.[input.accountId] ?? null });
  }

  // A reply to a replacement prompt picks that game; otherwise only an unambiguous window applies.
  const candidates = input.inReplyToId
    ? windows.filter((w) => w.promptStatusId === input.inReplyToId)
    : windows;
  if (input.inReplyToId ? candidates.length !== 1 : candidates.length > 1) {
    await dm(deps, input.accountId, m().errReplacementAmbiguous(), input.accountAcct);
    return { handled: true, kind: "replace_rejected", detail: "ambiguous replacement window" };
  }
  const game = candidates[0]?.game;
  if (!game) return null;
  if (position !== undefined && position !== game.currentRound) {
    await dm(deps, input.accountId, m().errReplaceWindowOnly(game.currentRound), input.accountAcct);
    return { handled: true, kind: "replace_rejected", detail: "position outside the open window" };
  }
  const result = await swapTune(input, deps, game, game.currentRound, url);
  if (result.kind === "tune_replaced") await emitRound(deps, game.id, game.currentRound);
  return result;
}

/** Swap the tune at `position` for the video in `url` (shared by both replace paths). */
async function swapTune(
  input: CommandInput,
  deps: HandlerDeps,
  game: Game,
  position: number,
  url: string,
): Promise<Handled> {
  const reject = async (text: string, detail: string): Promise<Handled> => {
    await dm(deps, input.accountId, text, input.accountAcct);
    return { handled: true, kind: "replace_rejected", detail };
  };
  const videoId = extractVideoId(url);
  if (!videoId) return reject(m().notPlayable(url), "not playable");

  const mine = loadTunes(deps.db, game.id).filter((t) => t.accountId === input.accountId);
  if (!mine.some((t) => t.position === position)) {
    return reject(m().errReplaceMissing(position), "no tune at position");
  }
  if (mine.some((t) => t.videoId === videoId && t.position !== position)) {
    return reject(m().alreadyInPlaylist(), "duplicate");
  }

  try {
    const resolved = await deps.resolveTitle(videoId);
    const current = loadGame(deps.db, game.id);
    const replacementStillOpen = current?.status === "ROUND" &&
      current.currentRound === position &&
      openReplacementDeadline(deps, current) !== null;
    const collectingStillOpen = current?.status === "COLLECTING" &&
      !!current.submissionDeadline &&
      deps.now().getTime() < new Date(current.submissionDeadline).getTime();
    if (!replacementStillOpen && !collectingStillOpen) {
      return reject(m().errNotCollecting(), "window closed");
    }
    deps.db
      .prepare(
        `UPDATE tunes SET video_id = ?, title = ?, canonical_url = ?
         WHERE game_id = ? AND account_id = ? AND position = ?`,
      )
      .run(resolved.videoId, resolved.title, resolved.canonicalUrl, game.id, input.accountId, position);
    await dm(
      deps,
      input.accountId,
      m().tuneReplaced(position, game.playlistLength, resolved.title),
      input.accountAcct,
    );
    return { handled: true, kind: "tune_replaced", detail: { position, videoId: resolved.videoId } };
  } catch (err) {
    const detail = errorText(err);
    deps.logger?.warn({ videoId, position, err: detail }, "tune replacement failed");
    return reject(m().resolveVideoError(), detail);
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
  const replaced = await replaceInWindow(input, deps, url, position);
  if (replaced) return replaced;

  const collecting = findCollectingGame(deps, input.accountId);
  if (!collecting) {
    await dm(deps, input.accountId, m().errNotCollecting(), input.accountAcct);
    return { handled: true, kind: "replace_rejected", detail: "not collecting" };
  }
  if (position < 1 || position > collecting.playlistLength) {
    await dm(deps, input.accountId, m().errReplacePosition(collecting.playlistLength), input.accountAcct);
    return { handled: true, kind: "replace_rejected", detail: "position out of range" };
  }
  return swapTune(input, deps, collecting, position, url);
}

async function maybeAdvanceToReady(deps: HandlerDeps, gameId: string): Promise<void> {
  const game = loadGame(deps.db, gameId)!;
  const players = loadPlayers(deps.db, gameId).filter((p) => p.inviteStatus === "accepted");
  const tunes = loadTunes(deps.db, gameId);
  const allComplete = players.every(
    (p) => tunes.filter((t) => t.accountId === p.accountId).length >= game.playlistLength,
  );
  if (!allComplete || players.length < 2) return;

  const finalized = finalizeCollection(game, players, tunes, game.playlistLength, deps.now());
  if (!saveGameState(deps.db, finalized.game, finalized.players, "COLLECTING")) return;
  if (finalized.outcome !== "ready") return;

  // READY → start round 1
  const started = startRound(finalized.game, 1, deps.now());
  if (!saveGame(deps.db, started, "READY")) return;

  // Post duel announcement on creation thread
  const text = m().duelStart(started.theme, started.playlistLength, players.length);
  await reply(deps, started.threadRootId ?? started.id, text);

  // Emit Round 1 posts (announce → tunes → poll), with auto-tie short-circuit
  await emitRound(deps, gameId, 1);
}

// ── notification ingestion ──────────────────────────────────

const POISON_ATTEMPTS = 3;

function isRateLimitNotificationError(err: unknown): boolean {
  return err instanceof RateLimitError || (err instanceof MastodonApiError && err.status === 429);
}

function isRetryableNotificationError(err: unknown): boolean {
  if (err instanceof ValidationError) return false;
  if (err instanceof MastodonApiError) return err.status === 429 || err.status === 408 || err.status >= 500;
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
  const logContext = {
    notificationId: n.id,
    kind: classified.kind,
    from: "accountAcct" in classified ? classified.accountAcct : undefined,
  };
  if (claim.changes === 0) {
    deps.logger?.debug(logContext, "notification skipped: already claimed or processed");
    return;
  }
  deps.logger?.debug(logContext, "notification claimed");

  try {
    let result: HandlerResult;
    if (classified.kind === "poll_expired") {
      await deps.onPollExpired?.(classified.statusId);
      result = { handled: true, kind: "poll_expired" };
    } else {
      result = await (classified.kind === "dm" ? handleDm : handlePublicCommand)(classified, deps);
    }

    deps.logger?.info({ ...logContext, result }, "notification handled");

    clearNotificationFailure(deps.db, n.id);
    deps.db
      .prepare("UPDATE processed_notifications SET processed_at = ? WHERE notification_id = ?")
      .run(deps.now().toISOString(), n.id);
  } catch (err) {
    const message = errorText(err);
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
    const nextAttemptAt = err instanceof RateLimitError
      ? new Date(err.resetAt * 1000).toISOString()
      : null;
    recordNotificationFailure(
      deps.db,
      n.id,
      attemptCount,
      message,
      nextAttemptAt,
      deadLettered ? deps.now().toISOString() : null,
    );
    if (deadLettered) {
      deps.db
        .prepare("UPDATE processed_notifications SET processed_at = 'error', attempts = ? WHERE notification_id = ?")
        .run(attemptCount, n.id);
      deps.logger?.error({ ...logContext, attempts: attemptCount, err: message }, "notification dead-lettered");
      return;
    }
    deps.logger?.warn(
      { ...logContext, attempts: attemptCount, rateLimited, err: message },
      "notification failed; will retry",
    );
    deps.db.prepare("DELETE FROM processed_notifications WHERE notification_id = ?").run(n.id);
    throw err;
  }
}
