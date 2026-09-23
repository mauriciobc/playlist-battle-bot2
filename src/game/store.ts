import type { Db } from "../db/index.js";
import { NON_TERMINAL_STATUS_SQL } from "../db/index.js";
import type { Game, Player, Tune } from "./types.js";

/**
 * Row mapping + persistence for games/players/tunes/rounds.
 * The single owner of SQL↔domain translation; handlers and scheduler both
 * go through this module instead of keeping private copies of the mappers.
 */

export function mapGame(r: Record<string, unknown>): Game {
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
    displayName: (r.display_name as string | null) ?? null,
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
  const result = expectedStatus === undefined
    ? db.prepare(
        `UPDATE games SET status=?, theme=?, playlist_length=?, host_account_id=?, poll_duration_sec=?,
          acceptance_deadline=?, submission_deadline=?, thread_root_id=?, current_round=?, pot=?,
          updated_at=? WHERE id=?`,
      ).run(
        g.status, g.theme, g.playlistLength, g.hostAccountId, g.pollDurationSec,
        g.acceptanceDeadline, g.submissionDeadline, g.threadRootId, g.currentRound, g.pot,
        g.updatedAt, g.id,
      )
    : db.prepare(
        `UPDATE games SET status=?, theme=?, playlist_length=?, host_account_id=?, poll_duration_sec=?,
          acceptance_deadline=?, submission_deadline=?, thread_root_id=?, current_round=?, pot=?,
          updated_at=? WHERE id=? AND status=?`,
      ).run(
        g.status, g.theme, g.playlistLength, g.hostAccountId, g.pollDurationSec,
        g.acceptanceDeadline, g.submissionDeadline, g.threadRootId, g.currentRound, g.pot,
        g.updatedAt, g.id, expectedStatus,
      );
  return result.changes === 1;
}

export function insertPlayer(db: Db, gameId: string, p: Player): void {
  db.prepare(
    `INSERT INTO players (game_id, account_id, acct, display_name, role, invite_status, points, joined_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(gameId, p.accountId, p.acct, p.displayName, p.role, p.inviteStatus, p.points, p.joinedAt);
}

/** Append a resolved tune to a player's playlist (position comes from the engine). */
export function insertTune(db: Db, gameId: string, t: Tune): void {
  db.prepare(
    `INSERT INTO tunes (game_id, account_id, position, video_id, title, canonical_url)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(gameId, t.accountId, t.position, t.videoId, t.title, t.canonicalUrl);
}

export function savePlayer(db: Db, gameId: string, p: Player): void {
  db.prepare(
    `UPDATE players SET acct=?, display_name=?, role=?, invite_status=?, points=?, joined_at=?
     WHERE game_id=? AND account_id=?`,
  ).run(p.acct, p.displayName, p.role, p.inviteStatus, p.points, p.joinedAt, gameId, p.accountId);
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

export function saveWalkoverRound(
  db: Db,
  gameId: string,
  round: number,
  winnerAccountId: string | null,
  participants: string[] = [],
  resolutionJson: string | null = null,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO rounds
      (game_id, number, status, winner_account_id, option_map_json, resolution_json)
     VALUES (?, ?, 'walkover', ?, ?, ?)`,
  ).run(gameId, round, winnerAccountId, JSON.stringify({ participants }), resolutionJson);
}

export function saveAutoTieRound(
  db: Db,
  gameId: string,
  round: number,
  optionMap: Record<string, unknown> = {},
  resolutionJson: string | null = null,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO rounds
      (game_id, number, status, option_map_json, resolution_json)
     VALUES (?, ?, 'auto_tied', ?, ?)`,
  ).run(gameId, round, JSON.stringify(optionMap), resolutionJson);
}

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

export function loadRound(
  db: Db,
  gameId: string,
  roundNumber: number,
): {
  status: string;
  winner_account_id: string | null;
  option_map_json: string;
  option_map: Record<string, unknown>;
  resolution_posted_at: string | null;
  resolution_json: string | null;
} | undefined {
  const row = db
    .prepare(
      "SELECT status, winner_account_id, option_map_json, resolution_posted_at, resolution_json FROM rounds WHERE game_id = ? AND number = ?",
    )
    .get(gameId, roundNumber) as
    | {
        status: string;
        winner_account_id: string | null;
        option_map_json: string;
        resolution_posted_at: string | null;
        resolution_json: string | null;
      }
    | undefined;
  if (!row) return undefined;
  let optionMap: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.option_map_json || "{}");
    if (parsed && typeof parsed === "object") optionMap = parsed as Record<string, unknown>;
  } catch {
    optionMap = {};
  }
  return { ...row, option_map: optionMap };
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

/**
 * Boot-time cleanup: drop in-flight notification claims left by a process
 * that died mid-handle, so those notifications are retried after restart.
 */
export type NotificationFailure = {
  notificationId: string;
  attempts: number;
  lastError: string;
  nextAttemptAt: string | null;
  deadLetteredAt: string | null;
  updatedAt: string;
};

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

export function listDeadLetteredNotifications(db: Db, limit = 100): NotificationFailure[] {
  return db
    .prepare(
      `SELECT notification_id AS notificationId, attempts, last_error AS lastError,
              next_attempt_at AS nextAttemptAt, dead_lettered_at AS deadLetteredAt,
              updated_at AS updatedAt
       FROM notification_failures
       WHERE dead_lettered_at IS NOT NULL
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(limit) as NotificationFailure[];
}

export function touchLoopHeartbeat(db: Db, loop: string, at: Date = new Date()): void {
  db.prepare(
    `INSERT INTO loop_heartbeats (loop, last_success_at) VALUES (?, ?)
     ON CONFLICT(loop) DO UPDATE SET last_success_at = excluded.last_success_at`,
  ).run(loop, at.toISOString());
}

export function lastSuccessfulLoopAt(db: Db): Date | null {
  const row = db
    .prepare("SELECT MAX(last_success_at) AS last_success_at FROM loop_heartbeats")
    .get() as { last_success_at: string | null } | undefined;
  return row?.last_success_at ? new Date(row.last_success_at) : null;
}

export type OutboxEffect = {
  id: string;
  method: "POST" | "DELETE";
  path: string;
  bodyJson: string | null;
  status: "pending" | "sent" | "failed" | "unknown";
  attempts: number;
  remoteId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

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

export function markOutboxSent(db: Db, id: string, remoteId: string | null): void {
  db.prepare(
    `UPDATE outbox_effects SET status = 'sent', remote_id = ?, updated_at = ? WHERE id = ?`,
  ).run(remoteId, new Date().toISOString(), id);
}

export function markOutboxFailed(db: Db, id: string, error: string, status: "failed" | "unknown" = "failed"): void {
  db.prepare(
    `UPDATE outbox_effects SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
  ).run(status, error, new Date().toISOString(), id);
}

export function listOutboxEffects(db: Db, status: OutboxEffect["status"], limit = 100): OutboxEffect[] {
  return db
    .prepare(
      `SELECT id, method, path, body_json AS bodyJson, status, attempts,
              remote_id AS remoteId, last_error AS lastError,
              created_at AS createdAt, updated_at AS updatedAt
       FROM outbox_effects WHERE status = ? ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(status, limit) as OutboxEffect[];
}

export function markStaleOutboxEffectsUnknown(db: Db, olderThanMs = 5 * 60_000): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const result = db
    .prepare(
      `UPDATE outbox_effects
       SET status = 'unknown', last_error = COALESCE(last_error, 'process restarted before completion'), updated_at = ?
        WHERE status = 'pending' AND updated_at <= ?`,
    )
    .run(new Date().toISOString(), cutoff);
  return result.changes;
}

export function releasePendingNotificationClaims(db: Db): void {
  db.prepare("DELETE FROM processed_notifications WHERE processed_at = ''").run();
}
