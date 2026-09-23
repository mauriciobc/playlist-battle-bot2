import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { GAME_STATUSES, TERMINAL_STATUSES } from "../game/types.js";

export type Db = Database.Database;

const statusCheck = GAME_STATUSES.map((s) => `'${s}'`).join(", ");

/**
 * SQL fragment `NOT IN ('CLOSED', ...)` derived from TERMINAL_STATUSES —
 * the single source of truth for "game is still open" queries.
 */
export const NON_TERMINAL_STATUS_SQL = `NOT IN (${TERMINAL_STATUSES.map((s) => `'${s}'`).join(", ")})`;

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE games (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN (${statusCheck})),
        theme TEXT NOT NULL,
        playlist_length INTEGER NOT NULL CHECK (playlist_length BETWEEN 8 AND 12),
        host_account_id TEXT NOT NULL,
        poll_duration_sec INTEGER NOT NULL CHECK (poll_duration_sec BETWEEN 300 AND 604800),
        acceptance_deadline TEXT,
        submission_deadline TEXT,
        thread_root_id TEXT,
        current_round INTEGER NOT NULL DEFAULT 0,
        pot INTEGER NOT NULL DEFAULT 0,
        last_dm_status_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE players (
        game_id TEXT NOT NULL REFERENCES games(id),
        account_id TEXT NOT NULL,
        acct TEXT NOT NULL,
        display_name TEXT,
        role TEXT NOT NULL CHECK (role IN ('host', 'challenger')),
        invite_status TEXT NOT NULL CHECK (invite_status IN ('pending', 'accepted', 'declined', 'expired')),
        forfeited_round INTEGER,
        points INTEGER NOT NULL DEFAULT 0,
        last_dm_status_id TEXT,
        joined_at TEXT,
        PRIMARY KEY (game_id, account_id)
      );

      CREATE TABLE tunes (
        game_id TEXT NOT NULL REFERENCES games(id),
        account_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 1),
        video_id TEXT NOT NULL,
        title TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
        round_status_id TEXT,
        UNIQUE (game_id, account_id, position),
        UNIQUE (game_id, account_id, video_id)
      );

      CREATE TABLE rounds (
        game_id TEXT NOT NULL REFERENCES games(id),
        number INTEGER NOT NULL CHECK (number >= 1),
        status TEXT NOT NULL CHECK (status IN ('announced', 'poll_open', 'auto_tied', 'resolved', 'walkover')),
        poll_status_id TEXT,
        poll_id TEXT,
        poll_expires_at TEXT,
        winner_account_id TEXT,
        option_map_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (game_id, number)
      );

      CREATE TABLE cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_notification_id TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO cursor (id, last_notification_id) VALUES (1, '');

      CREATE TABLE processed_notifications (
        notification_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      );

      CREATE TABLE video_cache (
        video_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT,
        fetched_at TEXT NOT NULL
      );

      CREATE INDEX idx_players_account ON players(account_id);
      CREATE INDEX idx_games_status ON games(status);
      CREATE INDEX idx_rounds_poll ON rounds(status, poll_expires_at);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE rounds ADD COLUMN watched_votes INTEGER;
      ALTER TABLE rounds ADD COLUMN votes_changed_at TEXT;
    `,
  },
  {
    version: 3,
    // v1.1 cleanup: v1.0 leftovers that no code path reads or writes any more —
    // partial-playlist forfeit round, per-player/game DM threading pointer, and
    // the round-status pointer on tunes.
    sql: `
      ALTER TABLE players DROP COLUMN forfeited_round;
      ALTER TABLE players DROP COLUMN last_dm_status_id;
      ALTER TABLE games DROP COLUMN last_dm_status_id;
      ALTER TABLE tunes DROP COLUMN round_status_id;
    `,
  },
  {
    version: 4,
    // Poison-notification handling: attempts must survive the claim being
    // deleted between retries, so failures are counted in a separate table.
    sql: `
      ALTER TABLE processed_notifications ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS claim_attempts (
        notification_id TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    version: 5,
    sql: `
      -- Finale playlist: the YT Music playlist published for a battle is recorded
      -- as soon as it exists, so a resumed finale reuses it instead of publishing
      -- a duplicate to the bot account.
      ALTER TABLE games ADD COLUMN battle_playlist_id TEXT;
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE players ADD COLUMN invite_sent_at TEXT;
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE games ADD COLUMN creation_status_id TEXT;
      CREATE UNIQUE INDEX idx_games_creation_status ON games(creation_status_id);
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE notification_failures (
        notification_id TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL,
        next_attempt_at TEXT,
        dead_lettered_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_notification_failures_dead ON notification_failures(dead_lettered_at);
    `,
  },
  {
    version: 9,
    sql: `
      ALTER TABLE games ADD COLUMN creation_visibility TEXT NOT NULL DEFAULT 'public';
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE loop_heartbeats (
        loop TEXT PRIMARY KEY,
        last_success_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 11,
    sql: `
      ALTER TABLE rounds ADD COLUMN poll_cleanup_pending INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 12,
    sql: `
      CREATE TABLE outbox_effects (
        id TEXT PRIMARY KEY,
        method TEXT NOT NULL CHECK (method IN ('POST', 'DELETE')),
        path TEXT NOT NULL,
        body_json TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'unknown')),
        attempts INTEGER NOT NULL DEFAULT 0,
        remote_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_outbox_effects_status ON outbox_effects(status, updated_at);
    `,
  },
  {
    version: 13,
    sql: `
      ALTER TABLE rounds ADD COLUMN watched_tally_json TEXT;
    `,
  },
  {
    version: 14,
    sql: `
      ALTER TABLE rounds ADD COLUMN resolution_posted_at TEXT;
      ALTER TABLE rounds ADD COLUMN resolution_json TEXT;
    `,
  },
  {
    version: 15,
    sql: `
      ALTER TABLE games ADD COLUMN finale_queue_url TEXT;
    `,
  },
];

export function openDatabase(path: string): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function migrate(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const run = db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        m.version,
        new Date().toISOString(),
      );
    });
    run();
  }
}
