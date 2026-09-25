import { collectingGameId, loadGame, roundGameIdsForPlayer, saveGame, saveGameState } from "../db/games.js";
import { loadPlayers } from "../db/players.js";
import { loadRound, roundMeta } from "../db/rounds.js";
import { insertTune, loadTunes, replaceTune } from "../db/tunes.js";
import { errorMessage } from "../errors.js";
import { finalizeCollection, startRound, submitTune, ValidationError } from "../game/engine.js";
import { FIRST_ROUND, MIN_PLAYERS, type Game, type Player, type Tune } from "../game/types.js";
import { m } from "../i18n/index.js";
import { dmAuthor } from "../mastodon/dm.js";
import { reply } from "../mastodon/reply.js";
import { emitRound } from "../scheduler/roundState.js";
import { extractVideoId } from "../youtube/normalize.js";
import type { ResolvedTune } from "../youtube/oembed.js";
import type { CommandInput, Handled, HandlerDeps, HandlerResult } from "./deps.js";

/** Why a link was turned down: the copy the player reads, and the reason the handler reports. */
type Rejection = { playerMessage: string; detail: string };

/** A link bound for a replacement window; `position` only when the player named one (`replace <n> <url>`). */
type ReplaceRequest = { url: string; position?: number };

type ReplacementWindow = { game: Game; promptStatusId: string | null };

type TuneSwap = { game: Game; position: number; url: string };

/** One DM's links on their way into the author's playlist. */
type LinkBatch = {
  author: CommandInput;
  game: Game;
  players: Player[];
  /** Every tune of the game, including the ones this batch added. */
  tunes: Tune[];
  accepted: number;
  lastRejection: Rejection | null;
};

/**
 * Links sent by DM. The first one replaces the player's round tune while its
 * replacement window is open (v1.1 1.4); otherwise they all go into the
 * player's playlist while the game is collecting.
 */
export async function handleLinkSubmission(
  input: CommandInput,
  deps: HandlerDeps,
  urls: string[],
): Promise<HandlerResult> {
  const replaced = await replaceInWindow(input, deps, { url: urls[0]! });
  if (replaced) return replaced;

  const game = findCollectingGame(deps, input.accountId);
  if (!game) {
    await dmAuthor(deps, input, m().noCollecting());
    return { handled: true, kind: "no_collecting_game" };
  }

  const batch = await submitLinks(input, deps, game, urls);
  const lastDetail = batch.lastRejection?.detail ?? null;
  if (batch.accepted > 0) {
    await startDuelOncePlaylistsComplete(deps, game.id);
    return { handled: true, kind: "tune_accepted", detail: { accepted: batch.accepted, lastError: lastDetail } };
  }

  await dmAuthor(deps, input, batch.lastRejection?.playerMessage ?? m().linkRejected());
  return { handled: true, kind: "tune_rejected", detail: lastDetail };
}

/**
 * v1.1 1.6: `replace <n> <url>` — swap tune n. While the game is collecting,
 * the last write wins before the submission deadline; while a round's
 * replacement window is open (v1.1 1.4) the same command targets the current
 * round's tune.
 */
export async function handleReplace(
  input: CommandInput,
  deps: HandlerDeps,
  request: { position: number; url: string },
): Promise<HandlerResult> {
  const replaced = await replaceInWindow(input, deps, request);
  if (replaced) return replaced;

  const game = findCollectingGame(deps, input.accountId);
  if (!game) {
    return rejectReplacement(input, deps, { playerMessage: m().errNotCollecting(), detail: "not collecting" });
  }
  const outsidePlaylist = request.position < 1 || request.position > game.playlistLength;
  if (outsidePlaylist) {
    return rejectReplacement(input, deps, {
      playerMessage: m().errReplacePosition(game.playlistLength),
      detail: "position out of range",
    });
  }
  return swapTune(input, deps, { game, position: request.position, url: request.url });
}

// ── replacement windows ─────────────────────────────────────

/**
 * Route a link into the player's open round-replacement window, if any.
 * Returns null when no window applies (the caller falls back to collection).
 */
async function replaceInWindow(
  input: CommandInput,
  deps: HandlerDeps,
  request: ReplaceRequest,
): Promise<Handled | null> {
  const windows = openReplacementWindows(deps, input.accountId);
  // RULES §3: a reply to a replacement notice picks that notice's game. Any
  // other DM — a reply to some other status included — applies to the only
  // open window, is ambiguous with several, and goes to collection with none.
  const repliedTo = input.inReplyToId
    ? windows.find((w) => w.promptStatusId === input.inReplyToId)
    : undefined;
  if (!repliedTo && windows.length > 1) {
    return rejectReplacement(input, deps, {
      playerMessage: m().errReplacementAmbiguous(),
      detail: "ambiguous replacement window",
    });
  }

  const game = (repliedTo ?? windows[0])?.game;
  if (!game) return null;
  const namesAnotherRound = request.position !== undefined && request.position !== game.currentRound;
  if (namesAnotherRound) {
    return rejectReplacement(input, deps, {
      playerMessage: m().errReplaceWindowOnly(game.currentRound),
      detail: "position outside the open window",
    });
  }

  const result = await swapTune(input, deps, { game, position: game.currentRound, url: request.url });
  if (result.kind === "tune_replaced") await emitRound(deps, game.id, game.currentRound);
  return result;
}

/** The player's ROUND games with an open replacement window on their round tune, oldest first. */
function openReplacementWindows(deps: HandlerDeps, accountId: string): ReplacementWindow[] {
  return roundGameIdsForPlayer(deps.db, accountId)
    .map((gameId) => openReplacementWindow(deps, gameId, accountId))
    .filter((window): window is ReplacementWindow => window !== null);
}

function openReplacementWindow(deps: HandlerDeps, gameId: string, accountId: string): ReplacementWindow | null {
  const game = loadGame(deps.db, gameId);
  if (!game || !isReplacementWindowOpen(deps, game)) return null;
  const holdsRoundTune = loadTunes(deps.db, game.id)
    .some((t) => t.accountId === accountId && t.position === game.currentRound);
  if (!holdsRoundTune) return null;
  const meta = roundMeta(loadRound(deps.db, game.id, game.currentRound));
  return { game, promptStatusId: meta.replacement?.prompts?.[accountId] ?? null };
}

/** Whether the current round's replacement window (v1.1 1.4) is still open. */
function isReplacementWindowOpen(deps: HandlerDeps, game: Game): boolean {
  const round = loadRound(deps.db, game.id, game.currentRound);
  const meta = roundMeta(round);
  const deadline = meta.replacement?.deadline;
  if (round?.status !== "announced" || meta.publishing || !deadline) return false;
  return deps.now().getTime() < new Date(deadline).getTime();
}

/** Swap the tune at `position` for the video in `url` (shared by both replace paths). */
async function swapTune(input: CommandInput, deps: HandlerDeps, swap: TuneSwap): Promise<Handled> {
  const { game, position, url } = swap;
  const videoId = extractVideoId(url);
  if (!videoId) return rejectReplacement(input, deps, { playerMessage: m().notPlayable(url), detail: "not playable" });

  const mine = loadTunes(deps.db, game.id).filter((t) => t.accountId === input.accountId);
  if (!mine.some((t) => t.position === position)) {
    return rejectReplacement(input, deps, {
      playerMessage: m().errReplaceMissing(position),
      detail: "no tune at position",
    });
  }
  if (mine.some((t) => t.videoId === videoId && t.position !== position)) {
    return rejectReplacement(input, deps, { playerMessage: m().alreadyInPlaylist(), detail: "duplicate" });
  }

  try {
    const resolved = await deps.resolveTitle(videoId);
    if (!isSwapStillOpen(deps, game.id, position)) {
      // Returned, not awaited: a failing rejection DM propagates rather than
      // reading as a failed swap.
      return rejectReplacement(input, deps, { playerMessage: m().errNotCollecting(), detail: "window closed" });
    }
    replaceTune(deps.db, game.id, input.accountId, position, resolved);
    await dmAuthor(deps, input, m().tuneReplaced(position, game.playlistLength, resolved.title));
    return { handled: true, kind: "tune_replaced", detail: { position, videoId: resolved.videoId } };
  } catch (err) {
    const detail = errorMessage(err);
    deps.logger?.warn({ videoId, position, err: detail }, "tune replacement failed");
    return rejectReplacement(input, deps, { playerMessage: m().resolveVideoError(), detail });
  }
}

/** Re-checked after the title lookup: the round's replacement window or the collection must still be open. */
function isSwapStillOpen(deps: HandlerDeps, gameId: string, position: number): boolean {
  const current = loadGame(deps.db, gameId);
  const replacementStillOpen = current?.status === "ROUND" &&
    current.currentRound === position &&
    isReplacementWindowOpen(deps, current);
  const collectingStillOpen = current?.status === "COLLECTING" &&
    !!current.submissionDeadline &&
    deps.now().getTime() < new Date(current.submissionDeadline).getTime();
  return replacementStillOpen || collectingStillOpen;
}

async function rejectReplacement(input: CommandInput, deps: HandlerDeps, rejection: Rejection): Promise<Handled> {
  await dmAuthor(deps, input, rejection.playerMessage);
  return { handled: true, kind: "replace_rejected", detail: rejection.detail };
}

// ── collection ──────────────────────────────────────────────

/** The player's live submission game (COLLECTING), or null. */
function findCollectingGame(deps: HandlerDeps, accountId: string): Game | null {
  const gameId = collectingGameId(deps.db, accountId, deps.now());
  return gameId ? loadGame(deps.db, gameId) : null;
}

async function submitLinks(input: CommandInput, deps: HandlerDeps, game: Game, urls: string[]): Promise<LinkBatch> {
  const batch: LinkBatch = {
    author: input,
    game,
    players: loadPlayers(deps.db, game.id),
    tunes: loadTunes(deps.db, game.id),
    accepted: 0,
    lastRejection: null,
  };
  for (const url of urls) {
    const rejection = await submitLink(deps, batch, url);
    if (rejection) batch.lastRejection = rejection;
  }
  return batch;
}

/** Add one link to the batch; returns why it was turned down, or null once it is in. */
async function submitLink(deps: HandlerDeps, batch: LinkBatch, url: string): Promise<Rejection | null> {
  const videoId = extractVideoId(url);
  if (!videoId) return { playerMessage: m().notPlayable(url), detail: "not playable" };
  // Cheap guard so a video we already hold never costs an oEmbed call.
  const alreadyHeld = batch.tunes.some((t) => t.accountId === batch.author.accountId && t.videoId === videoId);
  if (alreadyHeld) return { playerMessage: m().errVideoDup(), detail: "duplicate" };

  try {
    const resolved = await deps.resolveTitle(videoId);
    const added = addTune(deps, batch, resolved);
    await dmAuthor(deps, batch.author, tuneAcceptedMessage(batch, added, resolved.title));
    return null;
  } catch (err) {
    return submissionFailure(deps, videoId, err);
  }
}

/**
 * Store the tune and count it. It stays accepted from here on, even when the
 * confirmation DM that follows fails.
 */
function addTune(deps: HandlerDeps, batch: LinkBatch, resolved: ResolvedTune): Tune {
  // The engine owns the submission rules (status, player, capacity, dupes).
  const tunes = submitTune(batch.game, batch.players, batch.tunes, batch.author.accountId, resolved, deps.now());
  const added = tunes[tunes.length - 1]!;
  insertTune(deps.db, batch.game.id, added);
  // The engine's array is this player's authoritative playlist; re-reading it
  // would only re-fetch what is already here.
  batch.tunes = tunes;
  batch.accepted += 1;
  return added;
}

function tuneAcceptedMessage(batch: LinkBatch, added: Tune, title: string): string {
  const { playlistLength } = batch.game;
  const submitted = batch.tunes.filter((t) => t.accountId === added.accountId).length;
  return submitted >= playlistLength
    ? m().tuneAcceptedComplete(added.position, playlistLength, title)
    : m().tuneAcceptedMore(added.position, playlistLength, title, submitted + 1);
}

function submissionFailure(deps: HandlerDeps, videoId: string, err: unknown): Rejection {
  if (err instanceof ValidationError) return { playerMessage: err.message, detail: err.message };
  // Never DM internals (oEmbed/SQLite text): log them instead.
  const detail = errorMessage(err);
  deps.logger?.warn({ videoId, err: detail }, "tune submission failed");
  return { playerMessage: m().resolveVideoError(), detail };
}

/** Once every accepted player's playlist is complete, close collection and start round 1. */
async function startDuelOncePlaylistsComplete(deps: HandlerDeps, gameId: string): Promise<void> {
  const ready = closeCompletedCollection(deps, gameId);
  if (!ready) return;
  const started = startRound(ready.game, FIRST_ROUND, deps.now());
  if (!saveGame(deps.db, started, "READY")) return;

  // Duel announcement on the creation thread, then Round 1 (announce → tunes →
  // poll, or an auto-tie short-circuit).
  const announcement = m().duelStart(started.theme, started.playlistLength, ready.players.length);
  await reply(deps, started.threadRootId ?? started.id, announcement);
  await emitRound(deps, gameId, FIRST_ROUND);
}

/** COLLECTING → READY when every accepted player has a complete playlist; the READY game and its duelists, else null. */
function closeCompletedCollection(deps: HandlerDeps, gameId: string): { game: Game; players: Player[] } | null {
  const game = loadGame(deps.db, gameId)!;
  const players = loadPlayers(deps.db, gameId).filter((p) => p.inviteStatus === "accepted");
  const tunes = loadTunes(deps.db, gameId);
  const everyPlaylistComplete = players.every(
    (p) => tunes.filter((t) => t.accountId === p.accountId).length >= game.playlistLength,
  );
  if (!everyPlaylistComplete || players.length < MIN_PLAYERS) return null;

  const finalized = finalizeCollection(game, players, tunes, deps.now());
  if (!saveGameState(deps.db, finalized.game, finalized.players, "COLLECTING")) return null;
  return finalized.outcome === "ready" ? finalized : null;
}
