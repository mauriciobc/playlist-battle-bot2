import type { Db } from "./index.js";

/**
 * Merit announcement queue: one row per delivery still owed to a player.
 * Written in the finale transaction; drained by `scheduler/announcements.ts`.
 */

export type AnnouncementKind = "thread" | "dm";
export type AnnouncementStatus = "pending" | "sent" | "abandoned";

export type Announcement = {
  gameId: string;
  kind: AnnouncementKind;
  /** '' for the thread reply, which has no single recipient. */
  accountId: string;
  replyToId: string | null;
  attempts: number;
};

/**
 * Queue a delivery, due now. `INSERT OR IGNORE`: a resumed finale re-enqueues
 * the same rows, and one that was already sent or abandoned must stay so.
 */
export function enqueueAnnouncement(
  db: Db,
  input: { gameId: string; kind: AnnouncementKind; accountId?: string; replyToId?: string | null },
  at: Date,
): void {
  const iso = at.toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO merit_announcements
       (game_id, kind, account_id, reply_to_id, next_attempt_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.gameId, input.kind, input.accountId ?? "", input.replyToId ?? null, iso, iso);
}

/** Pending deliveries due at `now`, oldest first; optionally one game's only. */
export function dueAnnouncements(db: Db, now: Date, gameId?: string): Announcement[] {
  const rows = db
    .prepare(
      `SELECT game_id AS gameId, kind, account_id AS accountId, reply_to_id AS replyToId, attempts
         FROM merit_announcements
        WHERE status = 'pending' AND next_attempt_at <= ? AND (? IS NULL OR game_id = ?)
        ORDER BY next_attempt_at, game_id, kind DESC, account_id`,
    )
    .all(now.toISOString(), gameId ?? null, gameId ?? null) as Announcement[];
  return rows;
}

function key(a: Announcement): [string, string, string] {
  return [a.gameId, a.kind, a.accountId];
}

export function markAnnouncementSent(db: Db, a: Announcement, at: Date): void {
  db.prepare(
    `UPDATE merit_announcements SET status = 'sent', attempts = attempts + 1, last_error = NULL, updated_at = ?
      WHERE game_id = ? AND kind = ? AND account_id = ?`,
  ).run(at.toISOString(), ...key(a));
}

/** A failed attempt: retry at `retryAt`, or give up when it is null. */
export function markAnnouncementFailed(
  db: Db,
  a: Announcement,
  error: string,
  retryAt: Date | null,
  at: Date,
): void {
  db.prepare(
    `UPDATE merit_announcements
        SET status = ?, attempts = attempts + 1, last_error = ?,
            next_attempt_at = COALESCE(?, next_attempt_at), updated_at = ?
      WHERE game_id = ? AND kind = ? AND account_id = ?`,
  ).run(retryAt ? "pending" : "abandoned", error, retryAt?.toISOString() ?? null, at.toISOString(), ...key(a));
}
