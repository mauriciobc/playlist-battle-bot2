import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, migrate, type Db } from "../src/db/index.js";
import {
  clearNotificationFailure,
  recordNotificationFailure,
  markPendingOutboxEffectsUnknown,
  touchLoopHeartbeat,
} from "../src/game/store.js";

let db: Db;

function schemaVersion(): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  return row.v ?? 0;
}

function schemaVersionOf(db: Db): number {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  return row.v ?? 0;
}

function columns(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
});

afterEach(() => db.close());

describe("database migrations", () => {
  it("is idempotent — migrate twice leaves schema intact", () => {
    const v1 = schemaVersion();
    migrate(db);
    expect(schemaVersion()).toBe(v1);
  });

  it("enforces games status and playlist length constraints", () => {
    const insert = db.prepare(
      `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec, created_at, updated_at)
       VALUES (?, ?, 'Test', ?, 'acct1', 86400, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    );
    expect(() => insert.run("g1", "INVITED", 8)).not.toThrow();
    expect(() => insert.run("g2", "INVITED", 7)).toThrow(/CHECK/);
    expect(() => insert.run("g3", "INVITED", 13)).toThrow(/CHECK/);
    expect(() => insert.run("g4", "NOT_A_STATE", 8)).toThrow(/CHECK/);
  });

  it("enforces within-playlist video and position uniqueness (PRD §7 dup rejection)", () => {
    db.prepare(
      `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec, created_at, updated_at)
       VALUES ('g1', 'COLLECTING', 'T', 8, 'a1', 86400, 'x', 'x')`,
    ).run();
    const ins = db.prepare(
      `INSERT INTO tunes (game_id, account_id, position, video_id, title, canonical_url)
       VALUES ('g1', 'a1', ?, ?, 'T', 'https://www.youtube.com/watch')`,
    );
    ins.run(1, "dQw4w9WgXcQ");
    expect(() => ins.run(2, "dQw4w9WgXcQ")).toThrow(/UNIQUE/); // same video twice
    expect(() => ins.run(1, "abcdefghijk")).toThrow(/UNIQUE/); // same position twice
  });

  it("baseline carries no dead v1.0 columns, and v16 drops the last one", () => {
    const allColumns = () => [...columns(db, "players"), ...columns(db, "games"), ...columns(db, "tunes")];
    for (const c of ["forfeited_round", "last_dm_status_id", "round_status_id"]) {
      expect(allColumns()).not.toContain(c);
    }
    // players.display_name is dropped by v16: the baseline still declares it so
    // the same statement also cleans up volumes from the pre-squash chain.
    expect(columns(db, "players")).not.toContain("display_name");
  });

  it("drops players.display_name from a volume that predates v16", () => {
    // A volume migrated by the earlier chain: version 1 is recorded (so the
    // squashed baseline is skipped for it) and the dead column is still there.
    const legacy = openDatabase(":memory:");
    migrate(legacy);
    legacy.exec("ALTER TABLE players ADD COLUMN display_name TEXT");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 16").run();
    legacy
      .prepare(
        `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec, created_at, updated_at)
         VALUES ('g1', 'INVITED', 'T', 8, 'a1', 86400, 'x', 'x')`,
      )
      .run();
    legacy
      .prepare(
        "INSERT INTO players (game_id, account_id, acct, display_name, role, invite_status, points, joined_at) VALUES ('g1', 'a1', 'a1', 'Ada', 'host', 'accepted', 3, 'x')",
      )
      .run();
    expect(columns(legacy, "players")).toContain("display_name");

    migrate(legacy);

    expect(columns(legacy, "players")).not.toContain("display_name");
    // The upgrade keeps the rows it was given.
    expect(legacy.prepare("SELECT acct, points FROM players").get()).toEqual({ acct: "a1", points: 3 });
    expect(schemaVersionOf(legacy)).toBe(16);
    legacy.close();
  });

  it("cursor row is initialized to empty on migrate", () => {
    expect(db.prepare("SELECT last_notification_id FROM cursor WHERE id = 1").get()).toEqual({
      last_notification_id: "",
    });
  });
});

describe("store bookkeeping tables", () => {
  it("marks every pending outbox effect unknown at startup", () => {
    const insert = db.prepare(
      `INSERT INTO outbox_effects
       (id, method, path, status, attempts, created_at, updated_at)
       VALUES (?, 'POST', '/api/v1/statuses', ?, 0, ?, ?)`,
    );
    const now = new Date().toISOString();
    insert.run("stale-effect", "pending", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
    insert.run("fresh-effect", "pending", now, now);
    insert.run("sent-effect", "sent", now, now);
    expect(markPendingOutboxEffectsUnknown(db)).toBe(2);
    const unknown = db.prepare("SELECT id FROM outbox_effects WHERE status = 'unknown' ORDER BY id").all();
    expect(unknown).toEqual([{ id: "fresh-effect" }, { id: "stale-effect" }]);
  });

  it("records successful loop heartbeats", () => {
    const at = new Date("2026-09-21T12:00:00.000Z");
    touchLoopHeartbeat(db, "notifications", at);
    touchLoopHeartbeat(db, "notifications", new Date(at.getTime() + 1000));
    expect(db.prepare("SELECT loop, last_success_at FROM loop_heartbeats").all()).toEqual([
      { loop: "notifications", last_success_at: "2026-09-21T12:00:01.000Z" },
    ]);
  });

  it("persists and clears dead-lettered notification failures", () => {
    const deadLettered = () =>
      db.prepare(
        "SELECT notification_id, attempts, last_error FROM notification_failures WHERE dead_lettered_at IS NOT NULL",
      ).all();
    recordNotificationFailure(db, "n-1", 3, "HTTP 500", null, "2026-09-21T12:00:00.000Z");
    expect(deadLettered()).toEqual([{ notification_id: "n-1", attempts: 3, last_error: "HTTP 500" }]);
    clearNotificationFailure(db, "n-1");
    expect(deadLettered()).toHaveLength(0);
  });
});
