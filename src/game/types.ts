/**
 * Core domain types for Playlist Battle (PRD §3, §5).
 * Pure — no I/O, no Mastodon, no DB.
 */

export const GAME_STATUSES = [
  "CREATED",
  "INVITED",
  "COLLECTING",
  "READY",
  "ROUND",
  "FINALE",
  "CLOSED",
  "EXPIRED",
  "FIZZLED",
  "FORFEIT",
  "CANCELLED",
] as const;
export type GameStatus = (typeof GAME_STATUSES)[number];

export const TERMINAL_STATUSES: readonly GameStatus[] = [
  "CLOSED",
  "EXPIRED",
  "FIZZLED",
  "FORFEIT",
  "CANCELLED",
];

/** Tunes per playlist — and therefore rounds per duel. */
export const MIN_PLAYLIST_LENGTH = 8;
export const MAX_PLAYLIST_LENGTH = 12;

/** A duel needs two players; Mastodon polls carry at most four options, one per player. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;
export const MAX_CHALLENGERS = MAX_PLAYERS - 1;

export const FIRST_ROUND = 1;

export function isValidPlaylistLength(length: number): boolean {
  return length >= MIN_PLAYLIST_LENGTH && length <= MAX_PLAYLIST_LENGTH;
}

export type Player = {
  accountId: string;
  acct: string; // account handle for mentions (user@domain when remote)
  role: "host" | "challenger";
  inviteStatus: "pending" | "accepted" | "declined" | "expired";
  points: number;
  joinedAt: string | null;
};

export type Tune = {
  accountId: string;
  position: number; // 1..N, play order
  videoId: string;
  title: string;
  canonicalUrl: string;
};

/** A tune as resolved from YouTube, before it takes a playlist position. */
export type TuneDraft = Pick<Tune, "videoId" | "title" | "canonicalUrl">;

/** Votes one player's tune received in a round poll. */
export type Tally = { accountId: string; votes: number };

/** Final-round pot split: `count` tied players get `each` points, `total` in all. */
export type PotSplit = { total: number; each: number; count: number };

export type Game = {
  id: string;
  status: GameStatus;
  theme: string;
  playlistLength: number;
  hostAccountId: string;
  pollDurationSec: number;
  acceptanceDeadline: string | null;
  submissionDeadline: string | null;
  threadRootId: string | null;
  currentRound: number;
  pot: number;
  /** YT Music playlist published for the finale (crash-resume: never created twice). */
  battlePlaylistId: string | null;
  createdAt: string;
  updatedAt: string;
};

export function isTerminal(status: GameStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * Players eligible to play round k: accepted, not excluded for this round, and
 * holding a tune at position k (v1.1 full commitment — a complete playlist
 * always has one, so exclusions are the only source of round-level absence).
 */
export function eligibleForRound(
  players: Player[],
  tunes: Tune[],
  round: number,
  excluded?: ReadonlySet<string>,
): string[] {
  return players
    .filter(
      (p) =>
        p.inviteStatus === "accepted" &&
        !excluded?.has(p.accountId) &&
        tunes.some((t) => t.accountId === p.accountId && t.position === round),
    )
    .map((p) => p.accountId);
}

/** PRD §5.6: same canonical video for multiple players → automatic tie, no poll. */
export function hasRoundCollision(tunes: Tune[], round: number): boolean {
  const videoIds = tunes.filter((t) => t.position === round).map((t) => t.videoId);
  return new Set(videoIds).size !== videoIds.length;
}
