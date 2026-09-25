import type { Db } from "./index.js";
import type { NotificationCursor } from "../mastodon/notifications.js";

/**
 * Notification bookkeeping: the cursor, per-notification claims (so one is
 * never handled twice), retry attempts, and the failure / dead-letter record.
 */

/**
 * Notification cursor row: the id of the last handled notification. Persisted
 * so a restart resumes where the previous process stopped.
 */
export function readCursor(db: Db): NotificationCursor {
  const row = db.prepare("SELECT last_notification_id FROM cursor WHERE id = 1").get() as {
    last_notification_id: string;
  };
  return { lastId: row.last_notification_id };
}

export function writeCursor(db: Db, cursor: NotificationCursor): void {
  db.prepare("UPDATE cursor SET last_notification_id = ? WHERE id = 1").run(cursor.lastId);
}

// ── claims ──────────────────────────────────────────────────
// A claim is a processed_notifications row: processed_at '' while in flight,
// the completion time once handled, 'error' once dead-lettered.

/** Claim a notification for handling. False when it is already claimed or processed. */
export function claimNotification(db: Db, notificationId: string): boolean {
  return db
    .prepare("INSERT OR IGNORE INTO processed_notifications (notification_id, processed_at) VALUES (?, '')")
    .run(notificationId).changes === 1;
}

export function markNotificationProcessed(db: Db, notificationId: string, at: Date): void {
  db.prepare("UPDATE processed_notifications SET processed_at = ? WHERE notification_id = ?")
    .run(at.toISOString(), notificationId);
}

/** Terminal claim: the notification is never retried. */
export function markNotificationDeadLettered(db: Db, notificationId: string, attempts: number): void {
  db.prepare("UPDATE processed_notifications SET processed_at = 'error', attempts = ? WHERE notification_id = ?")
    .run(attempts, notificationId);
}

/** Drop a claim so the next poll retries the notification. */
export function releaseNotificationClaim(db: Db, notificationId: string): void {
  db.prepare("DELETE FROM processed_notifications WHERE notification_id = ?").run(notificationId);
}

/**
 * Boot-time cleanup: drop in-flight notification claims left by a process
 * that died mid-handle, so those notifications are retried after restart.
 */
export function releasePendingNotificationClaims(db: Db): void {
  db.prepare("DELETE FROM processed_notifications WHERE processed_at = ''").run();
}

// ── attempts ────────────────────────────────────────────────

/** Count one more failed attempt; returns the total so far. */
export function countFailedAttempt(db: Db, notificationId: string): number {
  const row = db
    .prepare(
      `INSERT INTO claim_attempts (notification_id, attempts) VALUES (?, 1)
       ON CONFLICT(notification_id) DO UPDATE SET attempts = attempts + 1
       RETURNING attempts`,
    )
    .get(notificationId) as { attempts: number } | undefined;
  return row?.attempts ?? 1;
}

export function resetFailedAttempts(db: Db, notificationId: string): void {
  db.prepare("DELETE FROM claim_attempts WHERE notification_id = ?").run(notificationId);
}

// ── failures ────────────────────────────────────────────────

export type NotificationFailure = {
  attempts: number;
  lastError: string;
  /** Earliest retry (a rate limit's reset), or null to retry on the next poll. */
  nextAttemptAt: string | null;
  /** Set once the notification will never be retried. */
  deadLetteredAt: string | null;
};

export function recordNotificationFailure(db: Db, notificationId: string, failure: NotificationFailure): void {
  db.prepare(
    `INSERT INTO notification_failures
       (notification_id, attempts, last_error, next_attempt_at, dead_lettered_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(notification_id) DO UPDATE SET
       attempts=excluded.attempts,
       last_error=excluded.last_error,
       next_attempt_at=excluded.next_attempt_at,
       dead_lettered_at=excluded.dead_lettered_at,
       updated_at=excluded.updated_at`,
  ).run(
    notificationId,
    failure.attempts,
    failure.lastError,
    failure.nextAttemptAt,
    failure.deadLetteredAt,
    new Date().toISOString(),
  );
}

export function clearNotificationFailure(db: Db, notificationId: string): void {
  db.prepare("DELETE FROM notification_failures WHERE notification_id = ?").run(notificationId);
}

/**
 * Notification ids whose next attempt is still in the future.
 *
 * Rate-limited failures record next_attempt_at = resetAt so a full window
 * can pass before the request is retried. Without a query that honours it,
 * the poller re-ran the notification on the next tick and the deferred
 * retry became an immediate one.
 */
export function deferUntilNotifications(db: Db, now: Date = new Date()): Set<string> {
  const rows = db
    .prepare(
      `SELECT notification_id AS notificationId
         FROM notification_failures
        WHERE dead_lettered_at IS NULL
          AND next_attempt_at IS NOT NULL
          AND next_attempt_at > ?`,
    )
    .all(now.toISOString()) as Array<{ notificationId: string }>;
  return new Set(rows.map((r) => r.notificationId));
}
