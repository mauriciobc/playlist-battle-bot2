import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, migrate } from "../src/db/index.js";
import {
  clearNotificationFailure,
  listDeadLetteredNotifications,
  recordNotificationFailure,
  lastSuccessfulLoopAt,
  listOutboxEffects,
  markStaleOutboxEffectsUnknown,
  touchLoopHeartbeat,
} from "../src/game/store.js";

let dir: string;
let dbPath: string;

function schemaVersion(db: import("better-sqlite3").Database): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  return row.v ?? 0;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pb-db-"));
  dbPath = join(dir, "test.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("database migrations", () => {
  it("creates all core tables on a fresh database", () => {
    const db = openDatabase(dbPath);
    migrate(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("games");
    expect(tables).toContain("players");
    expect(tables).toContain("tunes");
    expect(tables).toContain("rounds");
    expect(tables).toContain("cursor");
    expect(tables).toContain("processed_notifications");
    expect(tables).toContain("video_cache");
    db.close();
  });

  it("is idempotent — migrate twice leaves schema intact", () => {
    const db = openDatabase(dbPath);
    migrate(db);
    const v1 = schemaVersion(db);
    expect(() => migrate(db)).not.toThrow();
    expect(schemaVersion(db)).toBe(v1);
    db.close();
  });

  it("persists schema version", () => {
    const db = openDatabase(dbPath);
    migrate(db);
    expect(schemaVersion(db)).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it("enforces games status and playlist length constraints", () => {
    const db = openDatabase(dbPath);
    migrate(db);
    const insert = () =>
      db
        .prepare(
          `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("g1", "INVITED", "Test", 8, "acct1", 86400, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    expect(() => insert()).not.toThrow();
    // playlist_length must be 8..12
    expect(() =>
      db
        .prepare(
          `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("g2", "INVITED", "Test", 7, "acct1", 86400, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("g3", "INVITED", "Test", 13, "acct1", 86400, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
    ).toThrow();
    // unknown status rejected
    expect(() =>
      db
        .prepare(
          `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("g4", "NOT_A_STATE", "Test", 8, "acct1", 86400, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"),
    ).toThrow();
    db.close();
  });

  it("enforces within-playlist video uniqueness (PRD §7 dup rejection)", () => {
    const db = openDatabase(dbPath);
    migrate(db);
    db.prepare(
      `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec, created_at, updated_at)
       VALUES ('g1', 'COLLECTING', 'T', 8, 'a1', 86400, 'x', 'x')`,
    ).run();
    const ins = db.prepare(
      `INSERT INTO tunes (game_id, account_id, position, video_id, title, canonical_url)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    ins.run("g1", "a1", 1, "dQw4w9WgXcQ", "Never Gonna Give You Up", "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    // same video twice in one playlist → rejected
    expect(() =>
      ins.run("g1", "a1", 2, "dQw4w9WgXcQ", "Never Gonna Give You Up", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).toThrow();
    // same position twice → rejected
    expect(() =>
      ins.run("g1", "a1", 1, "abcdefghijk", "Other", "https://www.youtube.com/watch?v=abcdefghijk"),
    ).toThrow();
    db.close();
  });

  it("drops the v1.0 columns that no code path reads (v3)", () => {
    const db = openDatabase(dbPath);
    migrate(db);
    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns("players")).not.toContain("forfeited_round");
    expect(columns("players")).not.toContain("last_dm_status_id");
    expect(columns("games")).not.toContain("last_dm_status_id");
    expect(columns("tunes")).not.toContain("round_status_id");
    db.close();
  });

  it("upgrades a pre-v3 database that still carries those columns", () => {
    const db = openDatabase(dbPath);
    migrate(db);
    // Simulate a deployment created before v3: the columns are back and the
    // migration is no longer recorded as applied.
    db.exec(`
      ALTER TABLE players ADD COLUMN forfeited_round INTEGER;
      ALTER TABLE players ADD COLUMN last_dm_status_id TEXT;
      ALTER TABLE games ADD COLUMN last_dm_status_id TEXT;
      ALTER TABLE tunes ADD COLUMN round_status_id TEXT;
      DELETE FROM schema_migrations WHERE version = 3;
    `);

    migrate(db);

    const columns = (table: string) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    expect(columns("players")).not.toContain("forfeited_round");
    expect(columns("tunes")).not.toContain("round_status_id");
    expect(schemaVersion(db)).toBe(15);
    db.close();
  });

  it("marks stale pending outbox effects as unknown", () => {
    const db = openDatabase(dbPath);
    migrate(db);
    db.prepare(
      `INSERT INTO outbox_effects
       (id, method, path, status, attempts, created_at, updated_at)
       VALUES ('effect-1', 'POST', '/api/v1/statuses', 'pending', 0, ?, ?)`,
    ).run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
    expect(markStaleOutboxEffectsUnknown(db)).toBe(1);
    expect(listOutboxEffects(db, "unknown")).toMatchObject([{ id: "effect-1" }]);
    db.close();
  });

  it("marks all pending outbox effects unknown when requested at startup", () => {
    const db = openDatabase(dbPath);
    migrate(db);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO outbox_effects
       (id, method, path, status, attempts, created_at, updated_at)
       VALUES ('fresh-effect', 'POST', '/api/v1/statuses', 'pending', 0, ?, ?)`,
    ).run(now, now);
    expect(markStaleOutboxEffectsUnknown(db, 0)).toBe(1);
    expect(listOutboxEffects(db, "unknown")).toMatchObject([{ id: "fresh-effect" }]);
    db.close();
  });

  it("records successful loop heartbeats", () => {
    const db = openDatabase(dbPath);
    migrate(db);
    const at = new Date("2026-09-21T12:00:00.000Z");
    touchLoopHeartbeat(db, "notifications", at);
    expect(lastSuccessfulLoopAt(db)?.toISOString()).toBe(at.toISOString());
    db.close();
  });

  it("persists and clears dead-lettered notification failures", () => {
    const db = openDatabase(dbPath);
    migrate(db);
    recordNotificationFailure(db, "n-1", 3, "HTTP 500", null, "2026-09-21T12:00:00.000Z");
    expect(listDeadLetteredNotifications(db)).toMatchObject([
      { notificationId: "n-1", attempts: 3, lastError: "HTTP 500" },
    ]);
    clearNotificationFailure(db, "n-1");
    expect(listDeadLetteredNotifications(db)).toHaveLength(0);
    db.close();
  });

  it("cursor row is initialized to empty on migrate", () => {
    const db = openDatabase(dbPath);
    migrate(db);
    const row = db.prepare("SELECT last_notification_id FROM cursor WHERE id = 1").get() as
      | { last_notification_id: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.last_notification_id).toBe("");
    db.close();
  });
});
