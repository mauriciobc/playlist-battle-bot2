import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { deferUntilNotifications, recordNotificationFailure } from "../src/game/store.js";

/**
 * next_attempt_at was written on every rate-limited failure and never read.
 * The poller re-ran the same notification on the next tick, so the recorded
 * pause was ignored: 30 rate-limit errors in 11 minutes, cursor frozen,
 * one notification retried forever, each attempt another rejected POST that
 * refreshed the window being waited out.
 */
describe("deferUntilNotifications", () => {
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

  it("holds back a notification whose reset is still in the future", () => {
    const db = freshDb();
    const now = new Date("2026-09-24T14:00:00.000Z");
    recordNotificationFailure(
      db,
      "622936484",
      1,
      "Mastodon rate limit exhausted",
      "2026-09-24T14:05:00.000Z",
      null,
    );
    expect(deferUntilNotifications(db, now).has("622936484")).toBe(true);
  });

  it("releases it once resetAt has passed", () => {
    const db = freshDb();
    recordNotificationFailure(
      db,
      "622936484",
      1,
      "Mastodon rate limit exhausted",
      "2026-09-24T14:05:00.000Z",
      null,
    );
    const later = new Date("2026-09-24T14:06:00.000Z");
    expect(deferUntilNotifications(db, later).has("622936484")).toBe(false);
  });

  it("never defers a dead-lettered notification", () => {
    const db = freshDb();
    const now = new Date("2026-09-24T14:00:00.000Z");
    recordNotificationFailure(
      db,
      "dead",
      3,
      "poison",
      "2099-01-01T00:00:00.000Z",
      "2026-09-24T14:00:00.000Z",
    );
    expect(deferUntilNotifications(db, now).has("dead")).toBe(false);
  });

  it("never defers a plain failure with no schedule", () => {
    const db = freshDb();
    const now = new Date("2026-09-24T14:00:00.000Z");
    recordNotificationFailure(db, "plain", 1, "boom", null, null);
    expect(deferUntilNotifications(db, now).has("plain")).toBe(false);
  });

  it("leaves an unrelated notification alone", () => {
    const db = freshDb();
    const now = new Date("2026-09-24T14:00:00.000Z");
    recordNotificationFailure(db, "a", 1, "rl", "2099-01-01T00:00:00.000Z", null);
    const held = deferUntilNotifications(db, now);
    expect(held.has("a")).toBe(true);
    expect(held.has("b")).toBe(false);
  });
});
