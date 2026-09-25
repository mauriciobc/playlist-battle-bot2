import {
  awardVotePoints,
  applyPotBonus,
  resolveRoundScore,
  splitPotAmong,
  ROUND_QUORUM,
} from "./scoring.js";
import type { Game, GameStatus, Player, Tune } from "./types.js";
import { m, type Messages } from "../i18n/index.js";

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
  if (playlistLength < 8 || playlistLength > 12) {
    throw new ValidationError(msg.errLengthRange());
  }
  if (challengers.length < 1) {
    throw new ValidationError(msg.errMinChallenger());
  }
  const total = 1 + challengers.length;
  if (total > 4) {
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
  const acceptanceDeadline = new Date(
    input.now.getTime() + cfg.acceptanceWindowSec * 1000,
  ).toISOString();

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

export function acceptInvite(
  game: Game,
  players: Player[],
  accountId: string,
  now: Date = new Date(),
  msg: Messages = m(),
): { game: Game; players: Player[]; firstAccept: boolean } {
  const nowIso = now.toISOString();
  const target = players.find((p) => p.accountId === accountId);
  if (!target || target.role !== "challenger") {
    throw new ValidationError(msg.errNotInvited());
  }
  if (target.inviteStatus === "declined") {
    throw new ValidationError(msg.errAlreadyDeclined());
  }
  if (target.inviteStatus === "accepted") {
    return { game, players, firstAccept: false };
  }

  const updated = players.map((p) =>
    p.accountId === accountId
      ? { ...p, inviteStatus: "accepted" as const, joinedAt: nowIso }
      : p,
  );
  const alreadyCollecting = game.status === "COLLECTING";
  const anyAccepted = updated.some((p) => p.role === "challenger" && p.inviteStatus === "accepted");
  const status: GameStatus = alreadyCollecting || !anyAccepted ? game.status : "COLLECTING";
  return {
    game: { ...game, status, updatedAt: nowIso },
    players: updated,
    firstAccept: !alreadyCollecting && anyAccepted,
  };
}

export function declineInvite(
  game: Game,
  players: Player[],
  accountId: string,
  msg: Messages = m(),
): { game: Game; players: Player[] } {
  const target = players.find((p) => p.accountId === accountId);
  if (!target || target.role !== "challenger") {
    throw new ValidationError(msg.errNotInvited());
  }
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

export type TuneDraft = Pick<Tune, "videoId" | "title" | "canonicalUrl">;

export function submitTune(
  game: Game,
  players: Player[],
  tunes: Tune[],
  accountId: string,
  draft: TuneDraft,
  msg: Messages = m(),
  now: Date = new Date(),
): Tune[] {
  if (game.status !== "COLLECTING") {
    throw new ValidationError(msg.errNotCollecting());
  }
  if (!game.submissionDeadline || new Date(game.submissionDeadline).getTime() <= now.getTime()) {
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
  const position = mine.length + 1;
  return [
    ...tunes,
    {
      accountId,
      position,
      videoId: draft.videoId,
      title: draft.title,
      canonicalUrl: draft.canonicalUrl,
    },
  ];
}

export type FinalizeOutcome = "ready" | "fizzled" | "default_win";

/**
 * v1.1 full commitment: a playlist is valid only if complete. At the deadline,
 * every accepted player with fewer than N tunes withdraws (treated exactly as a
 * non-submitter). The duel starts only among players with complete playlists.
 */
export function finalizeCollection(
  game: Game,
  players: Player[],
  tunes: Tune[],
  playlistLength: number,
  now: Date,
): {
  game: Game;
  players: Player[];
  outcome: FinalizeOutcome;
  defaultWinnerId: string | null;
} {
  const nowIso = now.toISOString();
  const accepted = players.filter((p) => p.inviteStatus === "accepted");

  const countFor = (accountId: string) =>
    tunes.filter((t) => t.accountId === accountId).length;

  const completeIds = accepted.filter((p) => countFor(p.accountId) === playlistLength).map((p) => p.accountId);

  const updatedPlayers = players.map((p) => {
    if (p.inviteStatus !== "accepted") return p;
    if (countFor(p.accountId) < playlistLength) {
      // Withdrawn — incomplete at the deadline (v1.1 full commitment).
      return { ...p, inviteStatus: "declined" as const };
    }
    return p;
  });

  const base: Game = { ...game, updatedAt: nowIso };

  // Exactly one complete playlist → no duel, that player wins by default.
  if (completeIds.length === 1) {
    return {
      game: { ...base, status: "FINALE" },
      players: updatedPlayers,
      outcome: "default_win",
      defaultWinnerId: completeIds[0]!,
    };
  }

  if (completeIds.length === 0) {
    return {
      game: { ...base, status: "FIZZLED" },
      players: updatedPlayers,
      outcome: "fizzled",
      defaultWinnerId: null,
    };
  }

  // Two or more complete playlists.
  return {
    game: {
      ...base,
      status: "READY",
      submissionDeadline: nowIso,
    },
    players: updatedPlayers,
    outcome: "ready",
    defaultWinnerId: null,
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
  tallies: { accountId: string; votes: number }[];
  roundNumber: number;
  now: Date;
};

export type FinalSplit = { total: number; each: number; count: number };

export function resolveRound(input: ResolveRoundInput): {
  game: Game;
  players: Player[];
  winnerAccountId: string | null;
  potAwarded: number;
  finalSplit: FinalSplit | null;
} {
  const { game, players, tallies, roundNumber, now } = input;

  const score = resolveRoundScore({ tallies, pot: game.pot });
  let updated = awardVotePoints(players, tallies);

  const isFinal = roundNumber >= game.playlistLength;
  let potAfter = score.potAfter;
  let finalSplit: FinalSplit | null = null;

  if (isFinal && score.winnerAccountId === null) {
    // Final-round tie (v1.1): split the pre-round pot among the tied players
    // (integer division, remainder discarded); the pot does not grow.
    const totalVotes = tallies.reduce((sum, t) => sum + t.votes, 0);
    const topVotes = Math.max(0, ...tallies.map((t) => t.votes));
    const leaders = tallies.filter((t) => t.votes === topVotes);
    // Quorum-forced tie with a unique leader → all poll participants share.
    const quorumForced = totalVotes < ROUND_QUORUM && topVotes > 0 && leaders.length === 1;
    const tiedIds = (quorumForced ? tallies : leaders).map((t) => t.accountId);
    const split = splitPotAmong(updated, tiedIds, game.pot);
    updated = split.players;
    potAfter = 0;
    if (split.splitTotal > 0) {
      finalSplit = { total: split.splitTotal, each: split.splitEach, count: tiedIds.length };
    }
  } else {
    updated = applyPotBonus(updated, score.winnerAccountId, score.potAwarded);
  }

  return {
    game: {
      ...game,
      status: isFinal ? "FINALE" : "ROUND",
      pot: potAfter,
      currentRound: isFinal ? roundNumber : roundNumber + 1,
      updatedAt: now.toISOString(),
    },
    players: updated,
    winnerAccountId: score.winnerAccountId,
    potAwarded: score.potAwarded,
    finalSplit,
  };
}
