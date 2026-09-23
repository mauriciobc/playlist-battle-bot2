import type { HandlerDeps } from "../handlers/mention.js";
import { processNotification } from "../handlers/mention.js";
import { readCursor, writeCursor } from "../db/cursor.js";
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

  while (nextPath) {
    if (visited.has(nextPath)) {
      throw new Error("Notification pagination returned a repeated page");
    }
    visited.add(nextPath);
    const response: { data: RawNotification[]; linkNext: string | null } = deps.client.getWithLink
      ? await deps.client.getWithLink<RawNotification[]>(nextPath)
      : { data: await deps.client.get<RawNotification[]>(nextPath), linkNext: null };
    const notifications = response.data;

    if (!Array.isArray(notifications) || notifications.length === 0) {
      nextPath = response.linkNext;
      continue;
    }

    const sorted = [...notifications].sort((a, b) => {
      try {
        return Number(BigInt(a.id) - BigInt(b.id));
      } catch {
        return a.id < b.id ? -1 : 1;
      }
    });

    for (const n of sorted) {
      await processNotification(n, deps);
      current = advance(n.id, current);
    }
    nextPath = response.linkNext;
  }

  if (current.lastId !== cursor.lastId) writeCursor(deps.db, current);
}

type NotificationCursorDeps = Pick<HandlerDeps, "db" | "client">;

export async function initializeNotificationCursor(deps: NotificationCursorDeps): Promise<void> {
  const cursor = readCursor(deps.db);
  if (cursor.lastId) return;

  const response = deps.client.getWithLink
    ? await deps.client.getWithLink<RawNotification[]>("/api/v1/notifications?limit=1")
    : { data: await deps.client.get<RawNotification[]>("/api/v1/notifications?limit=1"), linkNext: null };
  if (!Array.isArray(response.data) || response.data.length === 0) return;

  const latest = response.data.reduce((max, notification) =>
    advance(notification.id, max).lastId === max.lastId ? max : { lastId: notification.id },
  { lastId: "" });
  if (latest.lastId) writeCursor(deps.db, latest);
}
