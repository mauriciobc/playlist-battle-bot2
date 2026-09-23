import type { Player } from "./types.js";

/**
 * Scoring rules (PRD §6, §5.6, §5.7).
 * Pure functions — no I/O.
 */

export type StandingsEntry = {
  accountId: string;
  points: number;
};

/** Award poll tallies: every vote = 1 permanent point to that tune's player. */
export function awardVotePoints(
  players: Player[],
  tallies: { accountId: string; votes: number }[],
): Player[] {
  const delta = new Map<string, number>();
  for (const t of tallies) {
    delta.set(t.accountId, (delta.get(t.accountId) ?? 0) + t.votes);
  }
  return players.map((p) => ({
    ...p,
    points: p.points + (delta.get(p.accountId) ?? 0),
  }));
}

/** Quorum (v1.1): a poll round with fewer than this many total votes is always a tie. */
export const ROUND_QUORUM = 3;

/**
 * Resolve a round from option tallies.
 * - Quorum (v1.1): fewer than ROUND_QUORUM total votes → tie, even if one option leads.
 * - Winner: strictly most votes → takes pot as bonus (pot returned as awarded amount).
 * - Tie (2+ way, including 3+): no winner, pot increases by 1 (PRD §5.6).
 * Returns updated pot and winner.
 */
export function resolveRoundScore(input: {
  tallies: { accountId: string; votes: number }[];
  pot: number;
}): { winnerAccountId: string | null; potAfter: number; potAwarded: number } {
  const { tallies, pot } = input;
  const totalVotes = tallies.reduce((sum, t) => sum + t.votes, 0);
  if (tallies.length === 0 || totalVotes < ROUND_QUORUM) {
    // no options, or quorum not met (covers the 0-vote case) → tie
    return { winnerAccountId: null, potAfter: pot + 1, potAwarded: 0 };
  }
  const sorted = [...tallies].sort((a, b) => b.votes - a.votes);
  const top = sorted[0]!;
  const tied = sorted.filter((t) => t.votes === top.votes);
  if (tied.length > 1 || top.votes === 0) {
    // tie (or everyone got zero → also a tie, no clear winner)
    return { winnerAccountId: null, potAfter: pot + 1, potAwarded: 0 };
  }
  return { winnerAccountId: top.accountId, potAfter: 0, potAwarded: pot };
}

/**
 * Final-round tie pot split (v1.1): divides the pot equally among the tied
 * players — integer division, remainder discarded. Callers must not have
 * incremented the pot first (a final tie does not grow the pot).
 */
export function splitPotAmong(
  players: Player[],
  tiedAccountIds: string[],
  pot: number,
): { players: Player[]; splitTotal: number; splitEach: number } {
  if (tiedAccountIds.length === 0 || pot <= 0) {
    return { players, splitTotal: 0, splitEach: 0 };
  }
  const each = Math.floor(pot / tiedAccountIds.length);
  if (each <= 0) {
    return { players, splitTotal: 0, splitEach: 0 };
  }
  const total = each * tiedAccountIds.length;
  const tied = new Set(tiedAccountIds);
  return {
    players: players.map((p) => (tied.has(p.accountId) ? { ...p, points: p.points + each } : p)),
    splitTotal: total,
    splitEach: each,
  };
}

/**
 * Final standings: highest points wins; exact tie → shared championship (PRD §6).
 * Pot bonus is already included in points when awarded.
 */
export function computeStandings(
  players: Player[],
): { champions: string[]; ordered: StandingsEntry[] } {
  const ordered = [...players]
    .map((p) => ({ accountId: p.accountId, points: p.points }))
    .sort((a, b) => b.points - a.points || a.accountId.localeCompare(b.accountId));
  if (ordered.length === 0) return { champions: [], ordered };
  const topPoints = ordered[0]!.points;
  const champions = ordered.filter((e) => e.points === topPoints).map((e) => e.accountId);
  return { champions, ordered };
}

/**
 * Apply a round result to player points: votes already added via awardVotePoints;
 * this only handles the pot bonus for a winner.
 */
export function applyPotBonus(players: Player[], winnerAccountId: string | null, potAwarded: number): Player[] {
  if (!winnerAccountId || potAwarded <= 0) return players;
  return players.map((p) =>
    p.accountId === winnerAccountId ? { ...p, points: p.points + potAwarded } : p,
  );
}
