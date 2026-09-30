import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { GAME_STATUSES, TERMINAL_STATUSES } from "../game/types.js";

/**
 * The persistence layer. This directory owns every SQL statement: `index.ts`
 * opens and migrates the database, and one module per table (games, players,
 * tunes, rounds, notifications, outbox, heartbeats, videoCache) translates
 * between rows and domain values. Handlers and the scheduler call those
 * functions and never write SQL themselves.
 */

export type Db = Database.Database;

const statusCheck = GAME_STATUSES.map((s) => `'${s}'`).join(", ");

/**
 * SQL fragment `NOT IN ('CLOSED', ...)` derived from TERMINAL_STATUSES —
 * the single source of truth for "game is still open" queries.
 */
export const NON_TERMINAL_STATUS_SQL = `NOT IN (${TERMINAL_STATUSES.map((s) => `'${s}'`).join(", ")})`;

/** `?, ?, …` — one bind placeholder per value, for an `IN (…)` list. */
export function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

/**
 * Applied in order at startup, each recorded in schema_migrations.
 *
 * Version 1 is a squashed baseline: the schema as fifteen incremental
 * migrations had left it, so a fresh database is created in one step instead
 * of replaying them. It still declares `players.display_name`, which version
 * 16 drops: an existing volume already has version 1 recorded (so the baseline
 * is skipped for it and only 16 runs), while a fresh one creates the column and
 * immediately drops it — SQLite has no `DROP COLUMN IF EXISTS`, and keeping the
 * runner ignorant of column state is worth the one wasted statement.
 */
const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      -- The v1.1 schema, in the shape the incremental migrations produced.
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        battle_playlist_id TEXT,
        creation_status_id TEXT,
        creation_visibility TEXT NOT NULL DEFAULT 'public',
        finale_queue_url TEXT
      );

      CREATE UNIQUE INDEX idx_games_creation_status ON games(creation_status_id);
      CREATE INDEX idx_games_status ON games(status);

      CREATE TABLE players (
        game_id TEXT NOT NULL REFERENCES games(id),
        account_id TEXT NOT NULL,
        acct TEXT NOT NULL,
        display_name TEXT,
        role TEXT NOT NULL CHECK (role IN ('host', 'challenger')),
        invite_status TEXT NOT NULL CHECK (invite_status IN ('pending', 'accepted', 'declined', 'expired')),
        points INTEGER NOT NULL DEFAULT 0,
        joined_at TEXT,
        invite_sent_at TEXT,
        PRIMARY KEY (game_id, account_id)
      );

      CREATE INDEX idx_players_account ON players(account_id);

      CREATE TABLE tunes (
        game_id TEXT NOT NULL REFERENCES games(id),
        account_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position >= 1),
        video_id TEXT NOT NULL,
        title TEXT NOT NULL,
        canonical_url TEXT NOT NULL,
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
        watched_votes INTEGER,
        watched_tally_json TEXT,
        votes_changed_at TEXT,
        poll_cleanup_pending INTEGER NOT NULL DEFAULT 0,
        resolution_posted_at TEXT,
        resolution_json TEXT,
        PRIMARY KEY (game_id, number)
      );

      CREATE INDEX idx_rounds_poll ON rounds(status, poll_expires_at);

      CREATE TABLE cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_notification_id TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO cursor (id, last_notification_id) VALUES (1, '');

      CREATE TABLE processed_notifications (
        notification_id TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE claim_attempts (
        notification_id TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE video_cache (
        video_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT,
        fetched_at TEXT NOT NULL
      );

      CREATE TABLE notification_failures (
        notification_id TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL,
        next_attempt_at TEXT,
        dead_lettered_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_notification_failures_dead ON notification_failures(dead_lettered_at);

      CREATE TABLE loop_heartbeats (
        loop TEXT PRIMARY KEY,
        last_success_at TEXT NOT NULL
      );

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
    version: 16,
    // Dead column: no code path ever wrote anything but NULL, so dropping it
    // loses nothing (v3 dropped the same kind of v1.0 leftovers).
    sql: `ALTER TABLE players DROP COLUMN display_name;`,
  },
  {
    version: 17,
    // Merit system (achievements + leaderboard). Career stats are derived from
    // these at read time — nothing here is an aggregate that can drift.
    //
    // `closed_at` is its own column rather than borrowing `updated_at`, which
    // every saveGame touches: a win-streak walk needs a stable ordering and
    // two games can close inside the same tick.
    //
    // game_results / game_participants are a snapshot written once in the same
    // transaction as FINALE -> CLOSED. Re-deriving the champion later from
    // players.points would be wrong: scoring.champions() runs over
    // duelParticipants, which drops withdrawn players, so an all-zero finale
    // (quorum-tie chain, pot zeroed) would crown everyone.
    //
    // badges is keyed (account_id, badge) so a badge is awarded once ever.
    // Tiers are distinct ids — plays_5, plays_25 — so a 5-win run is a
    // permanent high-water mark that a break in play cannot take away.
    sql: `
      ALTER TABLE games ADD COLUMN closed_at TEXT;

      CREATE TABLE game_results (
        game_id TEXT PRIMARY KEY REFERENCES games(id),
        theme TEXT NOT NULL,
        closed_at TEXT NOT NULL,
        champion_count INTEGER NOT NULL,
        champions_json TEXT NOT NULL
      );
      CREATE INDEX idx_game_results_closed ON game_results(closed_at);

      CREATE TABLE game_participants (
        game_id TEXT NOT NULL REFERENCES games(id),
        account_id TEXT NOT NULL,
        acct TEXT NOT NULL,
        role TEXT NOT NULL,
        points INTEGER NOT NULL,
        was_champion INTEGER NOT NULL,
        PRIMARY KEY (game_id, account_id)
      );
      CREATE INDEX idx_participants_account ON game_participants(account_id);

      CREATE TABLE badges (
        account_id TEXT NOT NULL,
        badge TEXT NOT NULL,
        awarded_at TEXT NOT NULL,
        game_id TEXT,
        PRIMARY KEY (account_id, badge)
      );
      CREATE INDEX idx_badges_awarded ON badges(awarded_at);
    `,
  },
  {
    version: 18,
    // Merit announcement queue. One row per delivery (the thread reply, and one
    // DM per awarded player), written in the finale transaction that closes the
    // game, so an announcement can never be lost to a crash and a failing post
    // can never keep a game open. `account_id` is '' for the thread row so the
    // primary key needs no NULL. `reply_to_id` is the finale summary the thread
    // reply answers. Delivery state lives here, not in the outbox: Mastodon only
    // honours an Idempotency-Key for about an hour, so this table is the
    // authority on what was delivered.
    sql: `
      CREATE TABLE merit_announcements (
        game_id TEXT NOT NULL REFERENCES games(id),
        kind TEXT NOT NULL,
        account_id TEXT NOT NULL DEFAULT '',
        reply_to_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (game_id, kind, account_id)
      );
      CREATE INDEX idx_merit_announcements_due ON merit_announcements(status, next_attempt_at);
    `,
  },
];

/**
 * SQLite compiles a statement on every `prepare` call, and the store,
 * scheduler and handlers prepare the same handful of statements thousands of
 * times while a game runs — it was 39% of the replayed workload. Memoize the
 * compiled statement on the connection so every caller keeps writing
 * `db.prepare(sql)` and pays the compile once.
 *
 * Statements are bound to the connection they came from, which is why the
 * cache lives on the instance: a `Db` from `openDatabase` may be closed and
 * collected freely, and the cached statements go with it.
 */
function memoizeStatements(db: Db): void {
  const compiled = new Map<string, Database.Statement>();
  const compile = db.prepare.bind(db);
  // The original `prepare` is generic over the bind parameters; the cache is
  // keyed by SQL text alone, so callers keep their own parameter types.
  db.prepare = ((sql: string) => {
    let statement = compiled.get(sql);
    if (statement === undefined) {
      statement = compile(sql);
      compiled.set(sql, statement);
    }
    return statement;
  }) as Db["prepare"];
}

export function openDatabase(path: string): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  memoizeStatements(db);
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
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString(),
      );
    })();
  }
}
