import type { Db } from "../db/index.js";
import { NON_TERMINAL_STATUS_SQL } from "../db/index.js";
import type { Game, Player, Tune } from "./types.js";
import type { NotificationCursor } from "../mastodon/notifications.js";

/**
 * Row mapping + persistence: games, players, tunes, rounds, notification
 * failures, loop heartbeats, the outbox ledger and the notification cursor.
 * The single owner of SQL↔domain translation; handlers and the scheduler both
 * go through this module instead of keeping private copies of the mappers.
 */

function mapGame(r: Record<string, unknown>): Game {
  return {
    id: r.id as string,
    status: r.status as Game["status"],
    theme: r.theme as string,
    playlistLength: r.playlist_length as number,
    hostAccountId: r.host_account_id as string,
    pollDurationSec: r.poll_duration_sec as number,
    acceptanceDeadline: (r.acceptance_deadline as string | null) ?? null,
    submissionDeadline: (r.submission_deadline as string | null) ?? null,
    threadRootId: (r.thread_root_id as string | null) ?? null,
    currentRound: r.current_round as number,
    pot: r.pot as number,
    battlePlaylistId: (r.battle_playlist_id as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function mapPlayer(r: Record<string, unknown>): Player {
  return {
    accountId: r.account_id as string,
    acct: r.acct as string,
    role: r.role as Player["role"],
    inviteStatus: r.invite_status as Player["inviteStatus"],
    points: r.points as number,
    joinedAt: (r.joined_at as string | null) ?? null,
  };
}

function mapTune(r: Record<string, unknown>): Tune {
  return {
    accountId: r.account_id as string,
    position: r.position as number,
    videoId: r.video_id as string,
    title: r.title as string,
    canonicalUrl: r.canonical_url as string,
  };
}

export function loadGame(db: Db, id: string): Game | null {
  const r = db.prepare("SELECT * FROM games WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? mapGame(r) : null;
}

export function loadPlayers(db: Db, gameId: string): Player[] {
  const rows = db
    .prepare(
      "SELECT * FROM players WHERE game_id = ? ORDER BY CASE WHEN role = 'host' THEN 0 ELSE 1 END, account_id",
    )
    .all(gameId) as Record<string, unknown>[];
  return rows.map(mapPlayer);
}

export function loadTunes(db: Db, gameId: string): Tune[] {
  const rows = db
    .prepare("SELECT * FROM tunes WHERE game_id = ? ORDER BY position, account_id")
    .all(gameId) as Record<string, unknown>[];
  return rows.map(mapTune);
}

export function insertGame(
  db: Db,
  g: Game,
  creationStatusId: string | null = null,
  creationVisibility: "public" | "unlisted" | "private" = "public",
): void {
  db.prepare(
    `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec,
      acceptance_deadline, submission_deadline, thread_root_id, current_round, pot, created_at, updated_at,
      creation_status_id, creation_visibility)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    g.id, g.status, g.theme, g.playlistLength, g.hostAccountId, g.pollDurationSec,
    g.acceptanceDeadline, g.submissionDeadline, g.threadRootId, g.currentRound, g.pot,
    g.createdAt, g.updatedAt, creationStatusId, creationVisibility,
  );
}

export function saveGame(db: Db, g: Game, expectedStatus?: Game["status"]): boolean {
  const guard = expectedStatus === undefined ? [] : [expectedStatus];
  const result = db.prepare(
    `UPDATE games SET status=?, theme=?, playlist_length=?, host_account_id=?, poll_duration_sec=?,
      acceptance_deadline=?, submission_deadline=?, thread_root_id=?, current_round=?, pot=?,
      updated_at=? WHERE id=?${guard.length ? " AND status=?" : ""}`,
  ).run(
    g.status, g.theme, g.playlistLength, g.hostAccountId, g.pollDurationSec,
    g.acceptanceDeadline, g.submissionDeadline, g.threadRootId, g.currentRound, g.pot,
    g.updatedAt, g.id, ...guard,
  );
  return result.changes === 1;
}

/** Atomically save a game (guarded by its expected status) and its players. */
/**
 * Move a game from `expected` to `next`, stamping updated_at. False when the
 * game is no longer in `expected`, so the caller can skip the side effects of
 * a transition another sweep already made.
 */
export function setGameStatus(
  db: Db,
  gameId: string,
  expected: Game["status"],
  next: Game["status"],
  at: Date,
): boolean {
  return db
    .prepare("UPDATE games SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
    .run(next, at.toISOString(), gameId, expected).changes === 1;
}

export function saveGameState(db: Db, g: Game, players: Player[], expectedStatus: Game["status"]): boolean {
  return db.transaction(() => {
    if (!saveGame(db, g, expectedStatus)) return false;
    for (const p of players) savePlayer(db, g.id, p);
    return true;
  })();
}

export function insertPlayer(db: Db, gameId: string, p: Player): void {
  db.prepare(
    `INSERT INTO players (game_id, account_id, acct, role, invite_status, points, joined_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(gameId, p.accountId, p.acct, p.role, p.inviteStatus, p.points, p.joinedAt);
}

/** Append a resolved tune to a player's playlist (position comes from the engine). */
export function insertTune(db: Db, gameId: string, t: Tune): void {
  db.prepare(
    `INSERT INTO tunes (game_id, account_id, position, video_id, title, canonical_url)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(gameId, t.accountId, t.position, t.videoId, t.title, t.canonicalUrl);
}

function savePlayer(db: Db, gameId: string, p: Player): void {
  db.prepare(
    `UPDATE players SET acct=?, role=?, invite_status=?, points=?, joined_at=?
     WHERE game_id=? AND account_id=?`,
  ).run(p.acct, p.role, p.inviteStatus, p.points, p.joinedAt, gameId, p.accountId);
}

/**
 * YT Music playlist published for the finale. Persisted the moment it exists so
 * a crash between creating it and closing the game cannot create a second one.
 */
export function saveBattlePlaylistId(db: Db, gameId: string, playlistId: string): void {
  db.prepare("UPDATE games SET battle_playlist_id = ? WHERE id = ?").run(playlistId, gameId);
}

/** Open (non-terminal) games the account participates in. */
export function openGamesForAccount(db: Db, accountId: string): { id: string; hostAccountId: string }[] {
  return db
    .prepare(
      `SELECT g.id, g.host_account_id AS hostAccountId FROM games g
       JOIN players p ON p.game_id = g.id
       WHERE p.account_id = ? AND g.status ${NON_TERMINAL_STATUS_SQL}`,
    )
    .all(accountId) as { id: string; hostAccountId: string }[];
}

/** Most recent game hosted by the account (creation-cooldown lookup). */
export function lastHostedCreation(db: Db, accountId: string): string | null {
  const row = db
    .prepare("SELECT created_at FROM games WHERE host_account_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(accountId) as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

// ── rounds ──────────────────────────────────────────────────

/** Round statuses that carry a decided result (poll, walkover or auto-tie). */
export const RESOLVED_ROUND_STATUSES: readonly string[] = ["resolved", "auto_tied", "walkover"];

export function savePollRound(
  db: Db,
  gameId: string,
  round: number,
  pollStatusId: string,
  pollId: string,
  pollExpiresAt: string,
  optionMap: Record<string, string>,
  pollCleanupPending = false,
): boolean {
  const result = db.prepare(
    `UPDATE rounds SET status = 'poll_open', poll_status_id = ?, poll_id = ?, poll_expires_at = ?,
       option_map_json = ?, poll_cleanup_pending = ?
     WHERE game_id = ? AND number = ? AND status = 'announced'`,
  ).run(
    pollStatusId,
    pollId,
    pollExpiresAt,
    JSON.stringify(optionMap),
    pollCleanupPending ? 1 : 0,
    gameId,
    round,
  );
  return result.changes === 1;
}

/** Mark a round row resolved with its winner (or null for tie). */
export function markRoundResolved(
  db: Db,
  gameId: string,
  roundNumber: number,
  winnerAccountId: string | null,
  optionMapPatch: Record<string, unknown> = {},
  pollCleanupPending = false,
  resolutionJson: string | null = null,
): void {
  const existing = loadRound(db, gameId, roundNumber);
  const base = (existing?.option_map ?? {}) as Record<string, unknown>;
  const merged = { ...base, ...optionMapPatch };
  db.prepare(
    `UPDATE rounds SET status = 'resolved', winner_account_id = ?, option_map_json = ?,
       poll_cleanup_pending = ?, resolution_json = ?
      WHERE game_id = ? AND number = ?`,
  ).run(
    winnerAccountId,
    JSON.stringify(merged),
    pollCleanupPending ? 1 : 0,
    resolutionJson,
    gameId,
    roundNumber,
  );
}

/** Rounds that produced a winner (for the finale thread). */
export function loadRoundWinners(
  db: Db,
  gameId: string,
): { number: number; winner_account_id: string }[] {
  return db
    .prepare("SELECT number, winner_account_id FROM rounds WHERE game_id = ? AND winner_account_id IS NOT NULL ORDER BY number ASC")
    .all(gameId) as { number: number; winner_account_id: string }[];
}

type RoundRow = {
  status: string;
  winner_account_id: string | null;
  option_map_json: string;
  resolution_posted_at: string | null;
  resolution_json: string | null;
};

const ROUND_COLUMNS = "status, winner_account_id, option_map_json, resolution_posted_at, resolution_json";

/** Attach the parsed `option_map_json`, tolerating a malformed or empty value. */
function withOptionMap(row: RoundRow): RoundRow & { option_map: Record<string, unknown> } {
  let optionMap: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.option_map_json || "{}");
    if (parsed && typeof parsed === "object") optionMap = parsed as Record<string, unknown>;
  } catch {
    optionMap = {};
  }
  return { ...row, option_map: optionMap };
}

export function loadRound(
  db: Db,
  gameId: string,
  roundNumber: number,
): (RoundRow & { option_map: Record<string, unknown> }) | undefined {
  const row = db
    .prepare(`SELECT ${ROUND_COLUMNS} FROM rounds WHERE game_id = ? AND number = ?`)
    .get(gameId, roundNumber) as RoundRow | undefined;
  return row ? withOptionMap(row) : undefined;
}

/** Every round of the game in play order — one query where a round-by-round loop would issue N. */
export function loadRounds(
  db: Db,
  gameId: string,
): { number: number; row: RoundRow & { option_map: Record<string, unknown> } }[] {
  const rows = db
    .prepare(`SELECT number, ${ROUND_COLUMNS} FROM rounds WHERE game_id = ? ORDER BY number`)
    .all(gameId) as (RoundRow & { number: number })[];
  return rows.map((row) => ({ number: row.number, row: withOptionMap(row) }));
}

/**
 * Metadata carried by `rounds.option_map_json` beyond the poll option index
 * map (see RULES.md §0): the replacement-window state v1.1 1.4 sets while a
 * round is `announced`, and the final-round pot-split v1.1 1.3 records on a
 * resolved/auto-tied final round.
 */
export type RoundMeta = {
  replacement?: { deadline?: string; notified?: string[]; prompts?: Record<string, string> };
  finalSplit?: { total: number; each: number; count: number };
  participants?: string[];
  publishing?: boolean;
};

export function roundMeta(row: { option_map?: Record<string, unknown> } | undefined): RoundMeta {
  return (row?.option_map ?? {}) as RoundMeta;
}

export function recordNotificationFailure(
  db: Db,
  notificationId: string,
  attempts: number,
  lastError: string,
  nextAttemptAt: string | null,
  deadLetteredAt: string | null,
): void {
  db.prepare(
    `INSERT INTO notification_failures
       (notification_id, attempts, last_error, next_attempt_at, dead_lettered_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(notification_id) DO UPDATE SET
       attempts=excluded.attempts,
       last_error=excluded.last_error,
       next_attempt_at=excluded.next_attempt_at,
       dead_lettered_at=excluded.dead_lettered_at,
       updated_at=excluded.updated_at`,
  ).run(
    notificationId,
    attempts,
    lastError,
    nextAttemptAt,
    deadLetteredAt,
    new Date().toISOString(),
  );
}

export function clearNotificationFailure(db: Db, notificationId: string): void {
  db.prepare("DELETE FROM notification_failures WHERE notification_id = ?").run(notificationId);
}

/**
 * Notification ids whose next attempt is still in the future.
 *
 * Rate-limited failures record next_attempt_at = resetAt so a full window
 * can pass before the request is retried. Without a query that honours it,
 * the poller re-ran the notification on the next tick and the deferred
 * retry became an immediate one.
 */
export function deferUntilNotifications(db: Db, now: Date = new Date()): Set<string> {
  const rows = db
    .prepare(
      `SELECT notification_id AS notificationId
         FROM notification_failures
        WHERE dead_lettered_at IS NULL
          AND next_attempt_at IS NOT NULL
          AND next_attempt_at > ?`,
    )
    .all(now.toISOString()) as Array<{ notificationId: string }>;
  return new Set(rows.map((r) => r.notificationId));
}

/**
 * Loops the scheduler runs. Each writes a heartbeat via touchLoopHeartbeat and
 * the healthcheck requires all of them to be fresh — one list, so a renamed or
 * added loop cannot leave the health contract behind.
 */
export const LOOP_LABELS = ["notifications", "deadlines", "polls", "recovery"] as const;

export function touchLoopHeartbeat(db: Db, loop: string, at: Date = new Date()): void {
  db.prepare(
    `INSERT INTO loop_heartbeats (loop, last_success_at) VALUES (?, ?)
     ON CONFLICT(loop) DO UPDATE SET last_success_at = excluded.last_success_at`,
  ).run(loop, at.toISOString());
}

export function createOutboxEffect(
  db: Db,
  id: string,
  method: "POST" | "DELETE",
  path: string,
  bodyJson: string | null,
): void {
  const existing = db
    .prepare("SELECT method, path, body_json FROM outbox_effects WHERE id = ?")
    .get(id) as { method: string; path: string; body_json: string | null } | undefined;
  if (existing) {
    if (existing.method !== method || existing.path !== path || existing.body_json !== bodyJson) {
      throw new Error(`Outbox effect ${id} was reused with different content`);
    }
    return;
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO outbox_effects
      (id, method, path, body_json, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
  ).run(id, method, path, bodyJson, now, now);
}

export function markOutboxSent(db: Db, id: string): void {
  db.prepare(
    `UPDATE outbox_effects SET status = 'sent', updated_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), id);
}

export function markOutboxFailed(db: Db, id: string, error: string, status: "failed" | "unknown" = "failed"): void {
  db.prepare(
    `UPDATE outbox_effects SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
  ).run(status, error, new Date().toISOString(), id);
}

/** Boot-time: effects still pending belong to a dead process and may or may not have landed. */
export function markPendingOutboxEffectsUnknown(db: Db): number {
  return db
    .prepare(
      `UPDATE outbox_effects
       SET status = 'unknown', last_error = COALESCE(last_error, 'process restarted before completion'), updated_at = ?
       WHERE status = 'pending'`,
    )
    .run(new Date().toISOString()).changes;
}

/**
 * Boot-time cleanup: drop in-flight notification claims left by a process
 * that died mid-handle, so those notifications are retried after restart.
 */
/**
 * Notification cursor row: the id of the last handled notification. Persisted
 * so a restart resumes where the previous process stopped.
 */
export function readCursor(db: Db): NotificationCursor {
  const row = db.prepare("SELECT last_notification_id FROM cursor WHERE id = 1").get() as {
    last_notification_id: string;
  };
  return { lastId: row.last_notification_id };
}

export function writeCursor(db: Db, cursor: NotificationCursor): void {
  db.prepare("UPDATE cursor SET last_notification_id = ? WHERE id = 1").run(cursor.lastId);
}

export function releasePendingNotificationClaims(db: Db): void {
  db.prepare("DELETE FROM processed_notifications WHERE processed_at = ''").run();
}
