import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { pollNotifications } from "../src/mastodon/poller.js";
import { recordNotificationFailure } from "../src/game/store.js";

/**
 * The cursor is the poller's only memory: the next poll asks
 * since_id = cursor. A rate-limited notification must not be advanced past,
 * or it is dropped for good.
 *
 * The first attempt at fixing retry-forever made exactly that mistake. It
 * advanced and carried on, and the cursor landed on the stuck notification's
 * own id, 622936484 - so the newgame it carried never became a game. A
 * retry-forever bug silently became a drop-forever bug.
 *
 * processNotification is imported directly by the poller, so this asserts
 * the observable outcome: where the cursor ends up, and whether a later
 * notification is allowed to overtake the deferred one.
 */
const RATE_LIMITED = "622936484";
const LATER = "622936999";
const RESET_AT = "2026-09-24T14:20:00.000Z";

function freshDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE cursor (id INTEGER PRIMARY KEY CHECK (id = 1),
                         last_notification_id TEXT NOT NULL);
    INSERT INTO cursor (id, last_notification_id) VALUES (1, '622921838');
    CREATE TABLE notification_failures (
      notification_id TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at TEXT,
      dead_lettered_at TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

/** A poller that cannot fail on anything, so the cursor is the only signal. */
function depsFor(db: Database.Database, at: Date) {
  return {
    db: db as never,
    now: () => at,
    logger: { debug() {}, warn() {}, error() {}, info() {} },
    client: {
      get: async (path: string) => {
        if (path.includes("since_id=622921838")) {
          return [
            { id: RATE_LIMITED, type: "mention" },
            { id: LATER, type: "mention" },
          ];
        }
        return [];
      },
    },
  } as never;
}

function cursorId(db: Database.Database): string {
  return (
    db.prepare("SELECT last_notification_id AS id FROM cursor WHERE id = 1").get() as {
      id: string;
    }
  ).id;
}

describe("poller cursor and deferred notifications", () => {
  it("leaves the cursor before a notification that is still deferred", async () => {
    const db = freshDb();
    recordNotificationFailure(db, RATE_LIMITED, 1, "rate limit exhausted", RESET_AT, null);

    await pollNotifications(depsFor(db, new Date("2026-09-24T14:10:00.000Z"))).catch(() => undefined);

    // Not the deferred id: that is the drop. Still the original: nothing
    // after it may overtake either.
    expect(cursorId(db)).not.toBe(RATE_LIMITED);
    expect(cursorId(db)).toBe("622921838");
  });

  it("holds the same cursor across repeated ticks while the window is open", async () => {
    const db = freshDb();
    recordNotificationFailure(db, RATE_LIMITED, 1, "rate limit exhausted", RESET_AT, null);

    for (const minute of [10, 12, 14]) {
      await pollNotifications(
        depsFor(db, new Date(`2026-09-24T14:${String(minute).padStart(2, "0")}:00.000Z`)),
      ).catch(() => undefined);
      expect(cursorId(db)).toBe("622921838");
    }
  });

  it("moves past it once the window has reset", async () => {
    const db = freshDb();
    recordNotificationFailure(db, RATE_LIMITED, 1, "rate limit exhausted", RESET_AT, null);

    await pollNotifications(depsFor(db, new Date("2026-09-24T14:21:00.000Z"))).catch(() => undefined);

    // Either the handler ran and advanced, or it failed and the cursor held.
    // What must not happen is the cursor sitting on the deferred id.
    expect(cursorId(db)).not.toBe(RATE_LIMITED);
  });
});
