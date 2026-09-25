import type { Player, PotSplit, Tally } from "./types.js";

/**
 * Scoring rules (PRD §6, §5.6, §5.7).
 * Pure functions — no I/O.
 */

/** Quorum (v1.1): a poll round with fewer than this many total votes is always a tie. */
export const ROUND_QUORUM = 3;

export function totalVotes(tallies: readonly Tally[]): number {
  return tallies.reduce((sum, t) => sum + t.votes, 0);
}

/** Award poll tallies: every vote = 1 permanent point to that tune's player. */
export function awardVotePoints(players: Player[], tallies: readonly Tally[]): Player[] {
  const delta = new Map<string, number>();
  for (const t of tallies) {
    delta.set(t.accountId, (delta.get(t.accountId) ?? 0) + t.votes);
  }
  return players.map((p) => ({
    ...p,
    points: p.points + (delta.get(p.accountId) ?? 0),
  }));
}

/**
 * Resolve a round from option tallies.
 * - Quorum (v1.1): fewer than ROUND_QUORUM total votes → tie, even if one option leads.
 * - Winner: strictly most votes → takes pot as bonus (pot returned as awarded amount).
 * - Tie (2+ way, including 3+): no winner, pot increases by 1 (PRD §5.6).
 * Returns updated pot and winner.
 */
export function resolveRoundScore(input: {
  tallies: readonly Tally[];
  pot: number;
}): { winnerAccountId: string | null; potAfter: number; potAwarded: number } {
  const { tallies, pot } = input;
  const tie = { winnerAccountId: null, potAfter: pot + 1, potAwarded: 0 };
  // No options, or quorum not met (covers the 0-vote case).
  if (tallies.length === 0 || totalVotes(tallies) < ROUND_QUORUM) return tie;

  const sorted = [...tallies].sort((a, b) => b.votes - a.votes);
  const top = sorted[0]!;
  const sharesTop = sorted.filter((t) => t.votes === top.votes).length > 1;
  if (sharesTop || top.votes === 0) return tie;
  return { winnerAccountId: top.accountId, potAfter: 0, potAwarded: pot };
}

/**
 * Who shares the pot when the final round ties (v1.1): the tied leaders — or,
 * when the tie is quorum-forced with a unique leader, every poll participant.
 */
export function finalTieSharers(tallies: readonly Tally[]): string[] {
  const topVotes = Math.max(0, ...tallies.map((t) => t.votes));
  const leaders = tallies.filter((t) => t.votes === topVotes);
  const quorumForced = totalVotes(tallies) < ROUND_QUORUM && topVotes > 0 && leaders.length === 1;
  return (quorumForced ? tallies : leaders).map((t) => t.accountId);
}

/**
 * Divide `pot` equally among `count` players — integer division, remainder
 * discarded. Null when nobody gets a point.
 */
export function potShares(pot: number, count: number): PotSplit | null {
  if (count === 0 || pot <= 0) return null;
  const each = Math.floor(pot / count);
  if (each <= 0) return null;
  return { total: each * count, each, count };
}

/**
 * Final-round tie pot split (v1.1): divides the pot equally among the tied
 * players. Callers must not have incremented the pot first (a final tie does
 * not grow the pot).
 */
export function splitPotAmong(
  players: Player[],
  tiedAccountIds: string[],
  pot: number,
): { players: Player[]; split: PotSplit | null } {
  const split = potShares(pot, tiedAccountIds.length);
  if (!split) return { players, split };
  const tied = new Set(tiedAccountIds);
  return {
    players: players.map((p) => (tied.has(p.accountId) ? { ...p, points: p.points + split.each } : p)),
    split,
  };
}

/** Standings order: most points first, account ID breaks ties stably. */
export function byStanding(a: Player, b: Player): number {
  return b.points - a.points || a.accountId.localeCompare(b.accountId);
}

/**
 * Final standings: highest points wins; exact tie → shared championship (PRD §6).
 * Pot bonus is already included in points when awarded.
 */
export function champions(players: Player[]): string[] {
  const top = Math.max(...players.map((p) => p.points));
  return players.filter((p) => p.points === top).sort(byStanding).map((p) => p.accountId);
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
