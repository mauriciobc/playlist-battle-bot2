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

/**
 * Whether a game still counts as open.
 *
 * The harness needs this to decide whether the environment is clean before
 * a run, and an ad-hoc query is a trap: mine listed CLOSED/FINALIZED/
 * CANCELLED, where FINALIZED is not a GameStatus and FIZZLED, EXPIRED and
 * FORFEIT were missing. It reported a FIZZLED game as open. Everything that
 * judges "open" must use this one definition, the same one
 * openGamesForAccount gates on via NON_TERMINAL_STATUS_SQL.
 */
export function isOpen(status: GameStatus): boolean {
  return !TERMINAL_STATUSES.includes(status);
}

/** Filter a mixed list down to the games that are still running. */
export function openGames<T extends { status: GameStatus }>(games: ReadonlyArray<T>): T[] {
  return games.filter((g) => isOpen(g.status));
}

export type PlayerRole = "host" | "challenger";
export type InviteStatus = "pending" | "accepted" | "declined" | "expired";

export type Player = {
  accountId: string;
  acct: string; // account handle for mentions (user@domain when remote)
  displayName: string | null;
  role: PlayerRole;
  inviteStatus: InviteStatus;
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

export type RoundStatus = "announced" | "poll_open" | "auto_tied" | "resolved" | "walkover";

export type Round = {
  number: number;
  status: RoundStatus;
  pollStatusId: string | null;
  pollId: string | null;
  pollExpiresAt: string | null;
  winnerAccountId: string | null;
  /** poll option index → accountId */
  optionMap: Record<string, string>;
};

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
  const byAccount = new Map<string, Tune[]>();
  for (const t of tunes) {
    const list = byAccount.get(t.accountId) ?? [];
    list.push(t);
    byAccount.set(t.accountId, list);
  }
  const ids: string[] = [];
  for (const p of players) {
    if (p.inviteStatus !== "accepted") continue;
    if (excluded?.has(p.accountId)) continue;
    const list = byAccount.get(p.accountId);
    if (list && list.some((t) => t.position === round)) ids.push(p.accountId);
  }
  return ids;
}

/** Video IDs played in round k (for auto-tie detection). */
export function videoIdsInRound(tunes: Tune[], round: number): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const t of tunes) {
    if (t.position !== round) continue;
    const list = map.get(t.videoId) ?? [];
    list.push(t.accountId);
    map.set(t.videoId, list);
  }
  return map;
}

/** PRD §5.6: same canonical video for multiple players → automatic tie, no poll. */
export function hasRoundCollision(tunes: Tune[], round: number): boolean {
  for (const accounts of videoIdsInRound(tunes, round).values()) {
    if (accounts.length > 1) return true;
  }
  return false;
}
