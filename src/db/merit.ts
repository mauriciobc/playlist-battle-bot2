import { type Db } from "./index.js";
import {
  bestWinStreak,
  earnedBadges,
  instanceOf,
  rankBoard,
  winCount,
  type BadgeId,
  type BoardEntry,
  type BoardMetric,
  type CareerInput,
  type DuelRecord,
} from "../game/merit.js";
import type { Player } from "../game/types.js";

/**
 * Merit tables: the per-duel results snapshot, the participation snapshot, and
 * the awarded-badge ledger. `game_results` is written once per closed duel in
 * the same transaction as the status flip, so it is the only authority on who
 * was crowned — career reads never re-derive a champion from `players.points`.
 */

/** A badge row, with the game that earned it. */
export type AwardedBadgeRow = {
  badge: BadgeId;
  awardedAt: string;
  gameId: string | null;
};

/** Stamp a game as closed. Called inside the finale transaction. */
export function markGameClosed(db: Db, gameId: string, at: Date): void {
  db.prepare("UPDATE games SET closed_at = ? WHERE id = ?").run(at.toISOString(), gameId);
}

/**
 * Record the closed duel: its theme, close time, and crowned accounts.
 * `INSERT OR REPLACE` so a resumed finale converges on the same row.
 */
export function insertGameResult(
  db: Db,
  input: { gameId: string; theme: string; closedAt: string; champions: string[] },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO game_results (game_id, theme, closed_at, champion_count, champions_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.gameId,
    input.theme,
    input.closedAt,
    input.champions.length,
    JSON.stringify(input.champions),
  );
}

/**
 * Record who played the duel and who was crowned.
 *
 * Only accounts in `duelers` are written: a withdrawn player is recorded
 * nowhere, which is exactly the exclusion `champions()` applies when it runs.
 */
export function insertParticipants(
  db: Db,
  gameId: string,
  duelers: readonly Player[],
  champions: readonly string[],
): void {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO game_participants (game_id, account_id, acct, role, points, was_champion)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (const p of duelers) {
    insert.run(gameId, p.accountId, p.acct, p.role, p.points, champions.includes(p.accountId) ? 1 : 0);
  }
}

/** A game a player took part in, as the merit layer sees it. */
type ParticipantRow = {
  game_id: string;
  account_id: string;
  role: string;
  was_champion: number;
  closed_at: string | null;
};

/** The account's own participation history, newest duel first. */
function historyOf(db: Db, accountId: string): ParticipantRow[] {
  return db
    .prepare(
      `SELECT p.game_id, p.account_id, p.role, p.was_champion, r.closed_at
         FROM game_participants p
         JOIN game_results r ON r.game_id = p.game_id
        WHERE p.account_id = ?
        ORDER BY r.closed_at DESC, p.game_id DESC`,
    )
    .all(accountId) as ParticipantRow[];
}

/**
 * Every closed duel the account played, newest first. Open games never reach
 * `game_results`, so a duel in flight cannot inflate a count.
 */
function duelsOf(rows: readonly ParticipantRow[]): DuelRecord[] {
  return rows.map((r) => ({
    gameId: r.game_id,
    closedAt: r.closed_at!,
    wasChampion: r.was_champion === 1,
  }));
}

/** Handles of every account that shared a duel with `accountId`, itself excluded. */
function opponentsOf(db: Db, accountId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT o.account_id AS id
         FROM game_participants mine
         JOIN game_participants o ON o.game_id = mine.game_id
        WHERE mine.account_id = ? AND o.account_id <> ?`,
    )
    .all(accountId, accountId) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/** Remote instances the account has met a player on, lowercased. */
function remoteInstancesOf(db: Db, accountId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT o.acct AS acct
         FROM game_participants mine
         JOIN game_participants o ON o.game_id = mine.game_id
        WHERE mine.account_id = ? AND o.account_id <> ?`,
    )
    .all(accountId, accountId) as { acct: string }[];
  const domains = new Set<string>();
  for (const r of rows) {
    const domain = instanceOf(r.acct);
    if (domain !== null) domains.add(domain);
  }
  return domains;
}

/** Whether the account ever completed a playlist as long as its duel. */
function completedFullPlaylist(db: Db, accountId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM game_participants p
         JOIN games g ON g.id = p.game_id
        WHERE p.account_id = ? AND g.closed_at IS NOT NULL
          AND (SELECT COUNT(*) FROM tunes t WHERE t.game_id = p.game_id AND t.account_id = p.account_id)
              = g.playlist_length
        LIMIT 1`,
    )
    .get(accountId) as { ok: number } | undefined;
  return row !== undefined;
}

/** Whether the account played a duel through its final round. */
function playedToFinalRound(db: Db, accountId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM game_participants p
         JOIN games g ON g.id = p.game_id
        WHERE p.account_id = ? AND g.closed_at IS NOT NULL
          AND p.was_champion = 1
          AND EXISTS (SELECT 1 FROM rounds r WHERE r.game_id = p.game_id AND r.number = g.playlist_length)
        LIMIT 1`,
    )
    .get(accountId) as { ok: number } | undefined;
  return row !== undefined;
}

/** Everything the badge rules need about one account. */
export function loadCareer(db: Db, accountId: string): CareerInput {
  const history = historyOf(db, accountId);
  return {
    accountId,
    duels: duelsOf(history),
    hostedCount: history.filter((r) => r.role === "host").length,
    remoteInstances: remoteInstancesOf(db, accountId),
    opponentCount: opponentsOf(db, accountId).size,
    completedFullPlaylist: completedFullPlaylist(db, accountId),
    playedToFinalRound: playedToFinalRound(db, accountId),
  };
}

/** Badge ids the account already holds. */
export function awardedBadges(db: Db, accountId: string): Set<BadgeId> {
  const rows = db
    .prepare("SELECT badge FROM badges WHERE account_id = ?")
    .all(accountId) as { badge: BadgeId }[];
  return new Set(rows.map((r) => r.badge));
}

/**
 * Award badges the account qualifies for but does not hold.
 *
 * Returns what was newly written. The primary key makes the write idempotent,
 * so a recovered finale awards nothing twice.
 */
export function awardNewBadges(
  db: Db,
  accountId: string,
  gameId: string,
  at: Date,
): BadgeId[] {
  const held = awardedBadges(db, accountId);
  const fresh = earnedBadges(loadCareer(db, accountId)).filter((b) => !held.has(b));
  if (fresh.length === 0) return [];
  const insert = db.prepare(
    `INSERT OR IGNORE INTO badges (account_id, badge, awarded_at, game_id) VALUES (?, ?, ?, ?)`,
  );
  const atIso = at.toISOString();
  for (const badge of fresh) insert.run(accountId, badge, atIso, gameId);
  return fresh;
}

/** Badges awarded in a game, in the order they were granted. */
export function badgesForGame(db: Db, gameId: string): AwardedBadgeRow[] {
  const rows = db
    .prepare("SELECT badge, awarded_at, game_id FROM badges WHERE game_id = ? ORDER BY awarded_at, badge")
    .all(gameId) as { badge: BadgeId; awarded_at: string; game_id: string | null }[];
  return rows.map((r) => ({ badge: r.badge, awardedAt: r.awarded_at, gameId: r.game_id }));
}

/** Account handle last recorded for an account, or null for a stranger. */
export function meritAcct(db: Db, accountId: string): string | null {
  const row = db
    .prepare("SELECT acct FROM game_participants WHERE account_id = ? ORDER BY rowid LIMIT 1")
    .get(accountId) as { acct: string } | undefined;
  return row?.acct ?? null;
}

/** Every ranked board row, before metric selection. */
function boardEntries(db: Db, since: string | null): BoardEntry[] {
  const rows = db
    .prepare(
      `SELECT p.account_id AS accountId, p.acct AS acct,
              SUM(p.was_champion) AS wins, COUNT(*) AS duels
         FROM game_participants p
         JOIN game_results r ON r.game_id = p.game_id
        WHERE (? IS NULL OR r.closed_at >= ?)
        GROUP BY p.account_id, p.acct`,
    )
    .all(since, since) as { accountId: string; acct: string; wins: number; duels: number }[];
  return rows.map((r) => ({ ...r, wins: Number(r.wins), duels: Number(r.duels) }));
}

/**
 * A leaderboard board over a window. `since` is inclusive; null ranks
 * everything recorded.
 */
export function loadBoard(
  db: Db,
  metric: BoardMetric,
  opts: { since?: string | null; minDuels?: number } = {},
): BoardEntry[] {
  return rankBoard(boardEntries(db, opts.since ?? null), metric, opts.minDuels ?? 0);
}

/** One account's position on a board: 1-based, or null when unranked. */
export function boardPosition(
  db: Db,
  accountId: string,
  metric: BoardMetric,
  opts: { since?: string | null; minDuels?: number } = {},
): number | null {
  const board = loadBoard(db, metric, opts);
  const index = board.findIndex((e) => e.accountId === accountId);
  return index === -1 ? null : index + 1;
}

/** Games closed and distinct players since a moment — the anti-void gate. */
export function boardActivity(db: Db, since: string): { closedDuels: number; distinctPlayers: number } {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT r.game_id) AS duels, COUNT(DISTINCT p.account_id) AS players
         FROM game_results r
         JOIN game_participants p ON p.game_id = r.game_id
        WHERE r.closed_at >= ?`,
    )
    .get(since) as { duels: number; players: number };
  return { closedDuels: row.duels, distinctPlayers: row.players };
}

/** Most recent closed duel, for posting a leaderboard into its thread. */
export function latestClosedGame(db: Db): { gameId: string; threadRootId: string | null } | null {
  const row = db
    .prepare(
      `SELECT r.game_id AS gameId, g.thread_root_id AS threadRootId
         FROM game_results r
         JOIN games g ON g.id = r.game_id
        WHERE g.thread_root_id IS NOT NULL
        ORDER BY r.closed_at DESC
        LIMIT 1`,
    )
    .get() as { gameId: string; threadRootId: string | null } | undefined;
  return row ?? null;
}

export { bestWinStreak, winCount };
