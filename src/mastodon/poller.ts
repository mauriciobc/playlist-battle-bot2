import type { HandlerDeps } from "../handlers/deps.js";
import { processNotification } from "../handlers/notification.js";
import { deferUntilNotifications, readCursor, writeCursor } from "../db/notifications.js";
import { advance, type NotificationCursor, type RawNotification } from "./notifications.js";

const NOTIFICATIONS_PATH = "/api/v1/notifications";

/** Notification types filtered out server-side: the bot never acts on them. */
const EXCLUDED_TYPES_QUERY = ["follow", "favourite", "reblog"]
  .map((type) => `exclude_types[]=${type}`)
  .join("&");

/** An empty cursor (no notification existed at first boot) pages from the very first one. */
const FIRST_MIN_ID = "0";

/**
 * Poll notifications with crash-safe cursor advance (PRD §7 restart).
 * Pages forward from the cursor, oldest first: `min_id` asks for the
 * notifications right after the cursor, and each page's rel="prev" link
 * leads to the next-newer one until an empty page. (`since_id` would serve
 * the newest page first, and Mastodon's rel="next" link drops the since_id
 * bound, walking the account's whole history.) The cursor is written only
 * after every handled notification resolved; failures leave it untouched
 * so the notification is retried next poll. Dedupe via
 * processed_notifications prevents double-handling on success.
 */
export async function pollNotifications(deps: HandlerDeps): Promise<void> {
  const start = readCursor(deps.db);
  // Notifications rate-limited on an earlier tick. They become due once
  // resetAt has passed; until then they are skipped, not retried.
  const deferred = deferUntilNotifications(deps.db, deps.now());

  let cursor = start;
  for await (const notifications of notificationPages(deps, start)) {
    const page = await processPage(deps, notifications, { cursor, deferred });
    cursor = page.cursor;
    if (page.reachedDeferred) break;
  }

  if (cursor.lastId !== start.lastId) {
    deps.logger?.debug(
      { from: start.lastId, to: cursor.lastId },
      "notification cursor advanced",
    );
    writeCursor(deps.db, cursor);
  }
}

type NotificationCursorDeps = Pick<HandlerDeps, "db" | "client">;

export async function initializeNotificationCursor(deps: NotificationCursorDeps): Promise<void> {
  const cursor = readCursor(deps.db);
  if (cursor.lastId) return;

  const response = await deps.client.getWithLink<RawNotification[]>(`${NOTIFICATIONS_PATH}?limit=1`);
  if (!Array.isArray(response.data) || response.data.length === 0) return;

  const latest = response.data.reduce(
    (newest: NotificationCursor, notification) => advance(notification.id, newest),
    { lastId: "" },
  );
  if (latest.lastId) writeCursor(deps.db, latest);
}

/** Every non-empty page of notifications after `since`, oldest page first, following rel="prev". */
async function* notificationPages(
  deps: HandlerDeps,
  since: NotificationCursor,
): AsyncGenerator<RawNotification[]> {
  const visited = new Set<string>();
  let nextPath: string | null =
    `${NOTIFICATIONS_PATH}?min_id=${encodeURIComponent(since.lastId || FIRST_MIN_ID)}&${EXCLUDED_TYPES_QUERY}`;

  while (nextPath) {
    if (visited.has(nextPath)) {
      throw new Error("Notification pagination returned a repeated page");
    }
    visited.add(nextPath);
    const response: { data: RawNotification[]; linkPrev: string | null } =
      await deps.client.getWithLink<RawNotification[]>(nextPath);
    nextPath = response.linkPrev;

    const notifications = response.data;
    if (!Array.isArray(notifications) || notifications.length === 0) continue;
    deps.logger?.debug(
      { count: notifications.length, page: visited.size, minId: since.lastId },
      "fetched notifications",
    );
    yield notifications;
  }
}

/** Handle one page oldest first; stops at a notification deferred by a rate limit, which ends the tick. */
async function processPage(
  deps: HandlerDeps,
  notifications: RawNotification[],
  tick: { cursor: NotificationCursor; deferred: ReadonlySet<string> },
): Promise<{ cursor: NotificationCursor; reachedDeferred: boolean }> {
  let cursor = tick.cursor;
  for (const n of [...notifications].sort(byIdAscending)) {
    if (tick.deferred.has(n.id)) {
      // Do NOT advance past this one. The cursor is what the next poll
      // asks for, so advancing here would drop the notification for good
      // and the deferred retry would never happen. Stop this tick instead
      // and let the next one see it again, once the window has reset.
      deps.logger?.debug(
        { notificationId: n.id },
        "notification deferred until its rate limit resets; ending tick",
      );
      return { cursor, reachedDeferred: true };
    }
    await processNotification(n, deps);
    cursor = advance(n.id, cursor);
  }
  return { cursor, reachedDeferred: false };
}

/** Mastodon IDs are numeric strings: compare them as BigInt when they parse. */
function byIdAscending(a: RawNotification, b: RawNotification): number {
  try {
    return Number(BigInt(a.id) - BigInt(b.id));
  } catch {
    return a.id < b.id ? -1 : 1;
  }
}
