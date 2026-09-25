import {
  applyPotBonus,
  awardVotePoints,
  finalTieSharers,
  resolveRoundScore,
  splitPotAmong,
} from "./scoring.js";
import {
  isValidPlaylistLength,
  MAX_PLAYERS,
  MIN_PLAYERS,
  type Game,
  type GameStatus,
  type Player,
  type PotSplit,
  type Tally,
  type Tune,
  type TuneDraft,
} from "./types.js";
import { m, type Messages } from "../i18n/index.js";
import { addSeconds } from "../time.js";

/**
 * Pure game engine — all PRD §5/§6/§7 lifecycle logic with zero I/O.
 * Callers (handlers/scheduler) persist results and perform Mastodon side effects.
 * Error copy is resolved through an injectable message catalog (defaults to the
 * process locale at call time) so domain errors never silently depend on global state.
 */

type Participant = {
  accountId: string;
  acct: string;
};

export type CreateGameInput = {
  host: Participant;
  theme: string;
  playlistLength: number;
  challengers: Participant[];
  now: Date;
};

export type CreateGameConfig = {
  pollDurationSec: number;
  acceptanceWindowSec: number;
  id: string;
};

export const MAX_THEME_LENGTH = 120;

export class ValidationError extends Error {
  override readonly name = "ValidationError";
}

export function validateCreate(input: CreateGameInput, msg: Messages = m()): void {
  const { host, theme, playlistLength, challengers } = input;
  if (!theme.trim()) throw new ValidationError(msg.errThemeEmpty());
  if (theme.trim().length > MAX_THEME_LENGTH) {
    throw new ValidationError(msg.errThemeTooLong(MAX_THEME_LENGTH));
  }
  if (!isValidPlaylistLength(playlistLength)) {
    throw new ValidationError(msg.errLengthRange());
  }
  if (1 + challengers.length < MIN_PLAYERS) {
    throw new ValidationError(msg.errMinChallenger());
  }
  if (1 + challengers.length > MAX_PLAYERS) {
    throw new ValidationError(msg.errMaxPlayers());
  }
  const ids = [host.accountId, ...challengers.map((c) => c.accountId)];
  if (new Set(ids).size !== ids.length) {
    throw new ValidationError(msg.errDuplicatePlayer());
  }
}

export function createGameInput(
  input: CreateGameInput,
  cfg: CreateGameConfig,
  msg: Messages = m(),
): { game: Game; players: Player[] } {
  validateCreate(input, msg);
  const nowIso = input.now.toISOString();
  const acceptanceDeadline = addSeconds(input.now, cfg.acceptanceWindowSec).toISOString();

  const game: Game = {
    id: cfg.id,
    status: "INVITED",
    theme: input.theme.trim(),
    playlistLength: input.playlistLength,
    hostAccountId: input.host.accountId,
    pollDurationSec: cfg.pollDurationSec,
    acceptanceDeadline,
    submissionDeadline: null,
    threadRootId: null,
    currentRound: 0,
    pot: 0,
    battlePlaylistId: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  const players: Player[] = [
    {
      accountId: input.host.accountId,
      acct: input.host.acct,
      role: "host",
      inviteStatus: "accepted",
      points: 0,
      joinedAt: nowIso,
    },
    ...input.challengers.map(
      (c): Player => ({
        accountId: c.accountId,
        acct: c.acct,
        role: "challenger",
        inviteStatus: "pending",
        points: 0,
        joinedAt: null,
      }),
    ),
  ];

  return { game, players };
}

function findInvitedChallenger(players: Player[], accountId: string, msg: Messages): Player {
  const target = players.find((p) => p.accountId === accountId);
  if (target?.role !== "challenger") {
    throw new ValidationError(msg.errNotInvited());
  }
  return target;
}

/** A challenger joins; the first acceptance opens submissions (COLLECTING). */
export function acceptInvite(
  game: Game,
  players: Player[],
  accountId: string,
  now: Date = new Date(),
  msg: Messages = m(),
): { game: Game; players: Player[]; firstAccept: boolean } {
  const target = findInvitedChallenger(players, accountId, msg);
  if (target.inviteStatus === "declined") {
    throw new ValidationError(msg.errAlreadyDeclined());
  }
  if (target.inviteStatus === "accepted") {
    return { game, players, firstAccept: false };
  }

  const nowIso = now.toISOString();
  const updated = players.map((p) =>
    p.accountId === accountId
      ? { ...p, inviteStatus: "accepted" as const, joinedAt: nowIso }
      : p,
  );
  return {
    game: { ...game, status: "COLLECTING", updatedAt: nowIso },
    players: updated,
    firstAccept: game.status !== "COLLECTING",
  };
}

export function declineInvite(
  game: Game,
  players: Player[],
  accountId: string,
  msg: Messages = m(),
): { game: Game; players: Player[] } {
  const target = findInvitedChallenger(players, accountId, msg);
  if (target.inviteStatus === "accepted") {
    throw new ValidationError(msg.errAlreadyAccepted());
  }
  const updated = players.map((p) =>
    p.accountId === accountId && p.inviteStatus === "pending"
      ? { ...p, inviteStatus: "declined" as const }
      : p,
  );
  return { game, players: updated };
}

function isCollectingAt(game: Game, now: Date): boolean {
  return game.status === "COLLECTING" &&
    game.submissionDeadline !== null &&
    now.getTime() < new Date(game.submissionDeadline).getTime();
}

/** Append `draft` to the player's playlist; returns every tune of the game. */
export function submitTune(
  game: Game,
  players: Player[],
  tunes: Tune[],
  accountId: string,
  draft: TuneDraft,
  now: Date = new Date(),
  msg: Messages = m(),
): Tune[] {
  if (!isCollectingAt(game, now)) {
    throw new ValidationError(msg.errNotCollecting());
  }
  const isPlayer = players.some(
    (p) => p.accountId === accountId && p.inviteStatus === "accepted",
  );
  if (!isPlayer) {
    throw new ValidationError(msg.errNotAcceptedPlayer());
  }
  const mine = tunes.filter((t) => t.accountId === accountId);
  if (mine.length >= game.playlistLength) {
    throw new ValidationError(msg.errPlaylistFull(game.playlistLength));
  }
  if (mine.some((t) => t.videoId === draft.videoId)) {
    throw new ValidationError(msg.errVideoDup());
  }
  const { videoId, title, canonicalUrl } = draft;
  return [...tunes, { accountId, position: mine.length + 1, videoId, title, canonicalUrl }];
}

export type FinalizeOutcome = "ready" | "fizzled" | "default_win";

const STATUS_AFTER_COLLECTION: Record<FinalizeOutcome, GameStatus> = {
  ready: "READY",
  fizzled: "FIZZLED",
  // Exactly one complete playlist → no duel, that player wins by default.
  default_win: "FINALE",
};

function finalizeOutcome(completePlaylists: number): FinalizeOutcome {
  if (completePlaylists === 0) return "fizzled";
  if (completePlaylists === 1) return "default_win";
  return "ready";
}

/**
 * v1.1 full commitment: a playlist is valid only if complete. At the deadline,
 * every accepted player with fewer than N tunes withdraws (treated exactly as a
 * non-submitter). The duel starts only among players with complete playlists.
 */
export function finalizeCollection(
  game: Game,
  players: Player[],
  tunes: Tune[],
  now: Date,
): {
  game: Game;
  players: Player[];
  outcome: FinalizeOutcome;
  defaultWinnerId: string | null;
} {
  const nowIso = now.toISOString();
  const tuneCount = (accountId: string) =>
    tunes.filter((t) => t.accountId === accountId).length;

  const completeIds = players
    .filter((p) => p.inviteStatus === "accepted" && tuneCount(p.accountId) === game.playlistLength)
    .map((p) => p.accountId);
  const updatedPlayers = players.map((p) =>
    p.inviteStatus === "accepted" && tuneCount(p.accountId) < game.playlistLength
      ? { ...p, inviteStatus: "declined" as const }
      : p,
  );

  const outcome = finalizeOutcome(completeIds.length);
  const finalized: Game = { ...game, status: STATUS_AFTER_COLLECTION[outcome], updatedAt: nowIso };
  // A duel that starts now closes submissions now.
  if (outcome === "ready") finalized.submissionDeadline = nowIso;
  return {
    game: finalized,
    players: updatedPlayers,
    outcome,
    defaultWinnerId: outcome === "default_win" ? completeIds[0]! : null,
  };
}

export function startRound(game: Game, round: number, now: Date = new Date()): Game {
  return {
    ...game,
    status: "ROUND",
    currentRound: round,
    updatedAt: now.toISOString(),
  };
}

export type ResolveRoundInput = {
  game: Game;
  players: Player[];
  tallies: Tally[];
  roundNumber: number;
  now: Date;
};

export function resolveRound(input: ResolveRoundInput): {
  game: Game;
  players: Player[];
  winnerAccountId: string | null;
  potAwarded: number;
  finalSplit: PotSplit | null;
} {
  const { game, players, tallies, roundNumber, now } = input;

  const score = resolveRoundScore({ tallies, pot: game.pot });
  const voted = awardVotePoints(players, tallies);
  const isFinal = roundNumber >= game.playlistLength;
  // Final-round tie (v1.1): the pre-round pot is split, and never grows.
  const isFinalTie = isFinal && score.winnerAccountId === null;
  const settled = isFinalTie
    ? splitPotAmong(voted, finalTieSharers(tallies), game.pot)
    : { players: applyPotBonus(voted, score.winnerAccountId, score.potAwarded), split: null };

  return {
    game: {
      ...game,
      status: isFinal ? "FINALE" : "ROUND",
      pot: isFinalTie ? 0 : score.potAfter,
      currentRound: isFinal ? roundNumber : roundNumber + 1,
      updatedAt: now.toISOString(),
    },
    players: settled.players,
    winnerAccountId: score.winnerAccountId,
    potAwarded: score.potAwarded,
    finalSplit: settled.split,
  };
}
