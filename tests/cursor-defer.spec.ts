import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { deferUntilNotifications, recordNotificationFailure } from "../src/game/store.js";

/**
 * The poller advances a cursor as it walks notifications, and the next poll
 * asks for since_id = cursor. A rate-limited notification must therefore
 * NOT be advanced past: doing so drops it for good.
 *
 * That is exactly what happened. The cursor went 622921838 -> 622936484,
 * the stuck notification's own id, and the newgame it carried never
 * produced a game. A retry-forever bug became a silent-drop bug.
 *
 * This asserts the property, independent of the poller's control flow.
 */
describe("deferred notifications and the cursor", () => {
  function freshDb() {
    const db = new Database(":memory:");
    db.exec(`
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

  const RATE_LIMITED = "622936484";
  const LATER = "622936999";
  const RESET_AT = "2026-09-24T14:20:00.000Z";

  it("is still deferred before the window, so the cursor must not move", () => {
    const db = freshDb();
    recordNotificationFailure(db, RATE_LIMITED, 1, "rate limit exhausted", RESET_AT, null);
    const deferred = deferUntilNotifications(db, new Date("2026-09-24T14:10:00.000Z"));
    expect(deferred.has(RATE_LIMITED)).toBe(true);
  });

  it("stays deferred across many ticks until the window passes", () => {
    const db = freshDb();
    recordNotificationFailure(db, RATE_LIMITED, 1, "rate limit exhausted", RESET_AT, null);
    for (const minute of [10, 12, 14, 16, 18]) {
      const at = new Date(`2026-09-24T14:${String(minute).padStart(2, "0")}:00.000Z`);
      expect(
        deferUntilNotifications(db, at).has(RATE_LIMITED),
        `still held at ${at.toISOString()}`,
      ).toBe(true);
    }
  });

  it("is released after the window, so the next tick can process it", () => {
    const db = freshDb();
    recordNotificationFailure(db, RATE_LIMITED, 1, "rate limit exhausted", RESET_AT, null);
    const after = new Date("2026-09-24T14:21:00.000Z");
    expect(deferUntilNotifications(db, after).has(RATE_LIMITED)).toBe(false);
  });

  it("does not release a later notification early to make room", () => {
    const db = freshDb();
    // A later id is visible to this poll but not yet due. Skipping the
    // deferred one and processing the other would let it overtake.
    const at = new Date("2026-09-24T14:10:00.000Z");
    expect(deferUntilNotifications(db, at).has(LATER)).toBe(false);
  });
});
