import type { Db } from "./index.js";

/**
 * Outbox ledger: every non-GET Mastodon request, keyed by its idempotency key,
 * so a restarted process can tell which side effects may already have landed.
 */

export type OutboxMethod = "POST" | "DELETE";

/**
 * Whether any effect whose id starts with `prefix` landed (`sent`) or may have
 * (`unknown`). A `failed` effect does not count: the caller may try again.
 *
 * The leaderboard reads this to decide whether it has already posted for the
 * current week: the outbox already knows which logical posts exist, so this
 * needs no separate ledger that could disagree with it.
 */
export function outboxLanded(db: Db, prefix: string): boolean {
  const escaped = prefix.replace(/[\\%_]/g, "\\$&");
  const row = db
    .prepare("SELECT 1 AS ok FROM outbox_effects WHERE id LIKE ? ESCAPE '\\' AND status IN ('sent','unknown') LIMIT 1")
    .get(`${escaped}%`);
  return row !== undefined;
}

export function createOutboxEffect(
  db: Db,
  id: string,
  method: OutboxMethod,
  path: string,
  bodyJson: string | null,
): void {
  const existing = db
    .prepare("SELECT method, path, body_json FROM outbox_effects WHERE id = ?")
    .get(id) as { method: string; path: string; body_json: string | null } | undefined;
  if (existing) {
    if (existing.method !== method || existing.path !== path || existing.body_json !== bodyJson) {
      throw new Error(`Outbox effect ${id} was reused with different content`);
    }
    return;
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO outbox_effects
      (id, method, path, body_json, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
  ).run(id, method, path, bodyJson, now, now);
}

export function markOutboxSent(db: Db, id: string): void {
  db.prepare(
    `UPDATE outbox_effects SET status = 'sent', updated_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), id);
}

/** `failed`: the server refused it. `unknown`: it may or may not have landed. */
export function markOutboxFailed(db: Db, id: string, error: string, status: "failed" | "unknown"): void {
  db.prepare(
    `UPDATE outbox_effects SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
  ).run(status, error, new Date().toISOString(), id);
}

/** Boot-time: effects still pending belong to a dead process and may or may not have landed. */
export function markPendingOutboxEffectsUnknown(db: Db): number {
  return db
    .prepare(
      `UPDATE outbox_effects
       SET status = 'unknown', last_error = COALESCE(last_error, 'process restarted before completion'), updated_at = ?
       WHERE status = 'pending'`,
    )
    .run(new Date().toISOString()).changes;
}
