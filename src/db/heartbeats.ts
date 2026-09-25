import { placeholders, type Db } from "./index.js";

/**
 * Loops the scheduler runs. Each writes a heartbeat via touchLoopHeartbeat and
 * the healthcheck requires all of them to be fresh — one list, so a renamed or
 * added loop cannot leave the health contract behind.
 */
export const LOOP_LABELS = ["notifications", "deadlines", "polls", "recovery"] as const;

export type LoopLabel = (typeof LOOP_LABELS)[number];

export function touchLoopHeartbeat(db: Db, loop: LoopLabel, at: Date = new Date()): void {
  db.prepare(
    `INSERT INTO loop_heartbeats (loop, last_success_at) VALUES (?, ?)
     ON CONFLICT(loop) DO UPDATE SET last_success_at = excluded.last_success_at`,
  ).run(loop, at.toISOString());
}

/** Last success of each loop that has ever succeeded. */
export function loopHeartbeats(db: Db): Map<LoopLabel, string> {
  const rows = db
    .prepare(`SELECT loop, last_success_at FROM loop_heartbeats WHERE loop IN (${placeholders(LOOP_LABELS)})`)
    .all(...LOOP_LABELS) as { loop: LoopLabel; last_success_at: string }[];
  return new Map(rows.map((row) => [row.loop, row.last_success_at]));
}
