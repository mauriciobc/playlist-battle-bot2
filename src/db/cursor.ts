import type { Db } from "./index.js";
import type { NotificationCursor } from "../mastodon/notifications.js";

/** Persistence for the notification cursor row (owned by the cursor table). */
export function readCursor(db: Db): NotificationCursor {
  const row = db.prepare("SELECT last_notification_id FROM cursor WHERE id = 1").get() as {
    last_notification_id: string;
  };
  return { lastId: row.last_notification_id };
}

export function writeCursor(db: Db, cursor: NotificationCursor): void {
  db.prepare("UPDATE cursor SET last_notification_id = ? WHERE id = 1").run(cursor.lastId);
}
