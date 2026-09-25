import { NON_TERMINAL_STATUS_SQL, placeholders, type Db } from "./index.js";
import { savePlayer } from "./players.js";
import type { Game, GameStatus, Player } from "../game/types.js";
import type { PublicVisibility } from "../mastodon/notifications.js";

/** Games table: the game aggregate root and the lookups that locate one. */

function mapGame(r: Record<string, unknown>): Game {
  return {
    id: r.id as string,
    status: r.status as GameStatus,
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

function ids(rows: unknown[]): string[] {
  return (rows as { id: string }[]).map((r) => r.id);
}

function firstId(row: unknown): string | null {
  return (row as { id: string } | undefined)?.id ?? null;
}

export function loadGame(db: Db, id: string): Game | null {
  const r = db.prepare("SELECT * FROM games WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? mapGame(r) : null;
}

export function insertGame(
  db: Db,
  g: Game,
  creationStatusId: string | null = null,
  creationVisibility: PublicVisibility = "public",
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

/** Persist every game field; with `expectedStatus`, only while the game is still in it. */
export function saveGame(db: Db, g: Game, expectedStatus?: GameStatus): boolean {
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
export function saveGameState(db: Db, g: Game, players: Player[], expectedStatus: GameStatus): boolean {
  return db.transaction(() => {
    if (!saveGame(db, g, expectedStatus)) return false;
    for (const p of players) savePlayer(db, g.id, p);
    return true;
  })();
}

/**
 * Move a game from `expected` to `next`, stamping updated_at. False when the
 * game is no longer in `expected`, so the caller can skip the side effects of
 * a transition another sweep already made.
 */
export function setGameStatus(
  db: Db,
  gameId: string,
  expected: GameStatus,
  next: GameStatus,
  at: Date,
): boolean {
  return db
    .prepare("UPDATE games SET status = ?, updated_at = ? WHERE id = ? AND status = ?")
    .run(next, at.toISOString(), gameId, expected).changes === 1;
}

/** `setGameStatus` for a closure: a void game also forfeits its pot. */
export function voidGame(db: Db, gameId: string, expected: GameStatus, next: GameStatus, at: Date): boolean {
  return db
    .prepare("UPDATE games SET status = ?, pot = 0, updated_at = ? WHERE id = ? AND status = ?")
    .run(next, at.toISOString(), gameId, expected).changes === 1;
}

/** A round is live while its game is in ROUND and still on that round. */
export function isLiveRound(db: Db, gameId: string, round: number): boolean {
  return db
    .prepare("SELECT 1 FROM games WHERE id = ? AND status = 'ROUND' AND current_round = ?")
    .get(gameId, round) !== undefined;
}

/** Move a live game from round `from` to the next one. False when it already moved on. */
export function advanceCurrentRound(db: Db, gameId: string, from: number, at: Date): boolean {
  return db
    .prepare(
      "UPDATE games SET current_round = ?, updated_at = ? WHERE id = ? AND status = 'ROUND' AND current_round = ?",
    )
    .run(from + 1, at.toISOString(), gameId, from).changes === 1;
}

export function setGamePot(db: Db, gameId: string, pot: number): void {
  db.prepare("UPDATE games SET pot = ? WHERE id = ?").run(pot, gameId);
}

/**
 * YT Music playlist published for the finale. Persisted the moment it exists so
 * a crash between creating it and closing the game cannot create a second one.
 */
export function saveBattlePlaylistId(db: Db, gameId: string, playlistId: string): void {
  db.prepare("UPDATE games SET battle_playlist_id = ? WHERE id = ?").run(playlistId, gameId);
}

/** The finale's battle link, persisted so a resumed finale posts the same one. */
export function loadFinaleQueueUrl(db: Db, gameId: string): string | null {
  const row = db
    .prepare("SELECT finale_queue_url FROM games WHERE id = ?")
    .get(gameId) as { finale_queue_url: string | null } | undefined;
  return row?.finale_queue_url ?? null;
}

export function saveFinaleQueueUrl(db: Db, gameId: string, url: string): void {
  db.prepare("UPDATE games SET finale_queue_url = ? WHERE id = ?").run(url, gameId);
}

// ── lookups ─────────────────────────────────────────────────

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

/** The game a creation mention already produced (redelivered notification). */
export function findGameByCreationStatus(
  db: Db,
  statusId: string,
): { id: string; creationVisibility: PublicVisibility } | null {
  const row = db
    .prepare("SELECT id, creation_visibility FROM games WHERE creation_status_id = ?")
    .get(statusId) as { id: string; creation_visibility: PublicVisibility } | undefined;
  return row ? { id: row.id, creationVisibility: row.creation_visibility } : null;
}

/** Most recent open game the account plays in. */
export function latestOpenGameId(db: Db, accountId: string): string | null {
  return firstId(
    db
      .prepare(
        `SELECT g.id FROM games g JOIN players p ON p.game_id = g.id
         WHERE p.account_id = ? AND g.status ${NON_TERMINAL_STATUS_SQL}
         ORDER BY g.created_at DESC LIMIT 1`,
      )
      .get(accountId),
  );
}

/** Most recent game the account hosts whose status is one of `statuses`. */
export function latestHostedGameId(db: Db, accountId: string, statuses: readonly GameStatus[]): string | null {
  return firstId(
    db
      .prepare(
        `SELECT g.id FROM games g JOIN players p ON p.game_id = g.id
         WHERE p.account_id = ? AND p.role = 'host'
           AND g.status IN (${placeholders(statuses)})
         ORDER BY g.created_at DESC LIMIT 1`,
      )
      .get(accountId, ...statuses),
  );
}

/**
 * Most recent game holding a pending invite for the account. Invites stay
 * valid during INVITED and after the first accept (COLLECTING) until the
 * acceptance window closes — checked in SQL so a DM landing after the deadline
 * (but before the sweep expires the invite) can't sneak in.
 */
export function pendingInviteGameId(db: Db, accountId: string, now: Date): string | null {
  return firstId(
    db
      .prepare(
        `SELECT g.id FROM games g JOIN players p ON p.game_id = g.id
         WHERE p.account_id = ? AND p.invite_status = 'pending' AND g.status IN ('INVITED', 'COLLECTING')
           AND (g.acceptance_deadline IS NULL OR g.acceptance_deadline > ?)
         ORDER BY g.created_at DESC LIMIT 1`,
      )
      .get(accountId, now.toISOString()),
  );
}

/** The player's live submission game (COLLECTING, before its deadline). */
export function collectingGameId(db: Db, accountId: string, now: Date): string | null {
  return firstId(
    db
      .prepare(
        `SELECT g.id FROM games g JOIN players p ON p.game_id = g.id
         WHERE p.account_id = ? AND p.invite_status = 'accepted' AND g.status = 'COLLECTING'
           AND g.submission_deadline IS NOT NULL AND g.submission_deadline > ?
         ORDER BY g.created_at DESC LIMIT 1`,
      )
      .get(accountId, now.toISOString()),
  );
}

/** Games in ROUND the account plays in, oldest first. */
export function roundGameIdsForPlayer(db: Db, accountId: string): string[] {
  return ids(
    db
      .prepare(
        `SELECT g.id FROM games g JOIN players p ON p.game_id = g.id
         WHERE p.account_id = ? AND p.invite_status = 'accepted' AND g.status = 'ROUND'
         ORDER BY g.created_at ASC, g.id ASC`,
      )
      .all(accountId),
  );
}

export function gameIdsWithStatus(db: Db, status: GameStatus): string[] {
  return ids(db.prepare("SELECT id FROM games WHERE status = ?").all(status));
}

/** Games in ROUND with the round they are on. */
export function gamesInRound(db: Db): { id: string; currentRound: number }[] {
  return db
    .prepare("SELECT id, current_round AS currentRound FROM games WHERE status = 'ROUND'")
    .all() as { id: string; currentRound: number }[];
}

// ── deadline sweeps ─────────────────────────────────────────

/** INVITED games past their acceptance deadline with no accepted challenger. */
export function unacceptedGameIdsPastDeadline(db: Db, now: Date): string[] {
  return ids(
    db
      .prepare(
        `SELECT id FROM games g
         WHERE status = 'INVITED' AND acceptance_deadline IS NOT NULL AND acceptance_deadline <= ?
           AND NOT EXISTS (SELECT 1 FROM players p WHERE p.game_id = g.id
                           AND p.role = 'challenger' AND p.invite_status = 'accepted')`,
      )
      .all(now.toISOString()),
  );
}

export function collectingGameIdsPastDeadline(db: Db, now: Date): string[] {
  return ids(
    db
      .prepare(
        `SELECT id FROM games
         WHERE status = 'COLLECTING' AND submission_deadline IS NOT NULL AND submission_deadline <= ?`,
      )
      .all(now.toISOString()),
  );
}

export type InterruptedCreation = {
  id: string;
  theme: string;
  creationStatusId: string;
  creationVisibility: PublicVisibility;
};

/** CREATED games whose creation mention is known, so creation can resume. */
export function interruptedCreations(db: Db): InterruptedCreation[] {
  return db
    .prepare(
      `SELECT id, theme, creation_status_id AS creationStatusId, creation_visibility AS creationVisibility
       FROM games WHERE status = 'CREATED' AND creation_status_id IS NOT NULL`,
    )
    .all() as InterruptedCreation[];
}

/** The game while it is still open (non-terminal); null once it ended, or when it does not exist. */
export function loadOpenGame(db: Db, id: string): Game | null {
  const r = db
    .prepare(`SELECT * FROM games WHERE id = ? AND status ${NON_TERMINAL_STATUS_SQL}`)
    .get(id) as Record<string, unknown> | undefined;
  return r ? mapGame(r) : null;
}
