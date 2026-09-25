import type { HandlerDeps } from "../handlers/mention.js";
import { processNotification } from "../handlers/mention.js";
import { deferUntilNotifications, readCursor, writeCursor } from "../game/store.js";
import { advance, type RawNotification } from "./notifications.js";

/**
 * Poll notifications with crash-safe cursor advance (PRD §7 restart).
 * Cursor only advances after processNotification resolves; failures leave
 * cursor untouched so the notification is retried next poll. Dedupe via
 * processed_notifications prevents double-handling on success.
 */
export async function pollNotifications(deps: HandlerDeps): Promise<void> {
  const cursor = readCursor(deps.db);
  const path = cursor.lastId
    ? `/api/v1/notifications?since_id=${encodeURIComponent(cursor.lastId)}&exclude_types[]=follow&exclude_types[]=favourite&exclude_types[]=reblog`
    : `/api/v1/notifications?exclude_types[]=follow&exclude_types[]=favourite&exclude_types[]=reblog`;

  let nextPath: string | null = path;
  const visited = new Set<string>();
  let current = cursor;

  // Notifications rate-limited on an earlier tick. They become due once
  // resetAt has passed; until then they are skipped, not retried.
  const deferred = deferUntilNotifications(deps.db, deps.now());

  while (nextPath) {
    if (visited.has(nextPath)) {
      throw new Error("Notification pagination returned a repeated page");
    }
    visited.add(nextPath);
    const response: { data: RawNotification[]; linkNext: string | null } =
      await deps.client.getWithLink<RawNotification[]>(nextPath);
    const notifications = response.data;

    if (!Array.isArray(notifications) || notifications.length === 0) {
      nextPath = response.linkNext;
      continue;
    }

    deps.logger?.debug(
      { count: notifications.length, page: visited.size, sinceId: cursor.lastId },
      "fetched notifications",
    );

    const sorted = [...notifications].sort((a, b) => {
      try {
        return Number(BigInt(a.id) - BigInt(b.id));
      } catch {
        return a.id < b.id ? -1 : 1;
      }
    });

    for (const n of sorted) {
      if (deferred.has(n.id)) {
        // Do NOT advance past this one. The cursor is what the next poll
        // asks for, so advancing here would drop the notification for good
        // and the deferred retry would never happen. Stop this tick instead
        // and let the next one see it again, once the window has reset.
        deps.logger?.debug(
          { notificationId: n.id },
          "notification deferred until its rate limit resets; ending tick",
        );
        break;
      }
      await processNotification(n, deps);
      current = advance(n.id, current);
    }
    nextPath = response.linkNext;
  }

  if (current.lastId !== cursor.lastId) {
    deps.logger?.debug(
      { from: cursor.lastId, to: current.lastId },
      "notification cursor advanced",
    );
    writeCursor(deps.db, current);
  }
}

type NotificationCursorDeps = Pick<HandlerDeps, "db" | "client">;

export async function initializeNotificationCursor(deps: NotificationCursorDeps): Promise<void> {
  const cursor = readCursor(deps.db);
  if (cursor.lastId) return;

  const response = await deps.client.getWithLink<RawNotification[]>("/api/v1/notifications?limit=1");
  if (!Array.isArray(response.data) || response.data.length === 0) return;

  const latest = response.data.reduce((max, notification) =>
    advance(notification.id, max).lastId === max.lastId ? max : { lastId: notification.id },
  { lastId: "" });
  if (latest.lastId) writeCursor(deps.db, latest);
}
