import type { Db } from "./index.js";
import type { Player } from "../game/types.js";

/** Players table: who plays each game, their invite state and points. */

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

/** Host first, then challengers by account ID. */
export function loadPlayers(db: Db, gameId: string): Player[] {
  const rows = db
    .prepare(
      "SELECT * FROM players WHERE game_id = ? ORDER BY CASE WHEN role = 'host' THEN 0 ELSE 1 END, account_id",
    )
    .all(gameId) as Record<string, unknown>[];
  return rows.map(mapPlayer);
}

export function insertPlayer(db: Db, gameId: string, p: Player): void {
  db.prepare(
    `INSERT INTO players (game_id, account_id, acct, role, invite_status, points, joined_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(gameId, p.accountId, p.acct, p.role, p.inviteStatus, p.points, p.joinedAt);
}

export function savePlayer(db: Db, gameId: string, p: Player): void {
  db.prepare(
    `UPDATE players SET acct=?, role=?, invite_status=?, points=?, joined_at=?
     WHERE game_id=? AND account_id=?`,
  ).run(p.acct, p.role, p.inviteStatus, p.points, p.joinedAt, gameId, p.accountId);
}

export function awardPoints(db: Db, gameId: string, accountId: string, points: number): void {
  db.prepare("UPDATE players SET points = points + ? WHERE game_id = ? AND account_id = ?").run(
    points, gameId, accountId,
  );
}

/** Any game's handle for the account, or null for a stranger. */
export function playerAcct(db: Db, accountId: string): string | null {
  const row = db
    .prepare("SELECT acct FROM players WHERE account_id = ?")
    .get(accountId) as { acct: string } | undefined;
  return row?.acct ?? null;
}

/** Pending challengers whose invite DM has not gone out yet, in invite order. */
export function unsentInvites(db: Db, gameId: string): { accountId: string; acct: string }[] {
  return db
    .prepare(
      `SELECT account_id AS accountId, acct FROM players
       WHERE game_id = ? AND invite_status = 'pending' AND invite_sent_at IS NULL ORDER BY rowid`,
    )
    .all(gameId) as { accountId: string; acct: string }[];
}

export function markInviteSent(db: Db, gameId: string, accountId: string, at: Date): void {
  db.prepare("UPDATE players SET invite_sent_at = ? WHERE game_id = ? AND account_id = ?")
    .run(at.toISOString(), gameId, accountId);
}

/** Expire invites still pending once their game's acceptance window closed. Returns how many. */
export function expirePendingInvites(db: Db, now: Date): number {
  return db
    .prepare(
      `UPDATE players SET invite_status = 'expired'
       WHERE invite_status = 'pending' AND game_id IN (
         SELECT id FROM games WHERE status IN ('INVITED','COLLECTING')
           AND acceptance_deadline IS NOT NULL AND acceptance_deadline <= ?)`,
    )
    .run(now.toISOString()).changes;
}
