/**
 * In-process claims: the availability window re-entry, the deadline sweep,
 * the poll fast-path and emitRound can race for the same round/finale/poll.
 * Whoever fails to claim defers to the holder. Scoped to this process —
 * sufficient for the single-container deployment; two processes sharing one
 * SQLite file would need a database-level lease instead.
 */

const claims = new Set<string>();

export const claimKey = {
  round: (gameId: string, round: number) => `round:${gameId}#${round}`,
  poll: (gameId: string, round: number) => `poll:${gameId}#${round}`,
  finale: (gameId: string) => `finale:${gameId}`,
};

export function isClaimed(key: string): boolean {
  return claims.has(key);
}

/** Run `task` holding `key`; skip it when another task already holds the key. */
export async function exclusively(key: string, task: () => Promise<void>): Promise<void> {
  if (claims.has(key)) return;
  claims.add(key);
  try {
    await task();
  } finally {
    claims.delete(key);
  }
}
