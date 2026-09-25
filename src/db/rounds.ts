import { NON_TERMINAL_STATUS_SQL, placeholders, type Db } from "./index.js";
import type { GameStatus, PotSplit } from "../game/types.js";

/**
 * Rounds table: one row per round once it is announced, polled or decided
 * without a poll. `option_map_json` carries the poll's option index → account
 * ID map plus the round's RoundMeta.
 */

export type RoundStatus = "announced" | "poll_open" | "auto_tied" | "resolved" | "walkover";

/** Round statuses that carry a decided result (poll, walkover or auto-tie). */
export const RESOLVED_ROUND_STATUSES: readonly RoundStatus[] = ["resolved", "auto_tied", "walkover"];

/**
 * Metadata carried by `rounds.option_map_json` beyond the poll option index
 * map (see RULES.md §0): the replacement-window state v1.1 1.4 sets while a
 * round is `announced`, and the final-round pot-split v1.1 1.3 records on a
 * resolved/auto-tied final round.
 */
export type RoundMeta = {
  replacement?: { deadline?: string; notified?: string[]; prompts?: Record<string, string> };
  finalSplit?: PotSplit;
  participants?: string[];
  /** Set while the round thread is being posted: no replacement window is open. */
  publishing?: boolean;
};

export type Round = {
  number: number;
  status: RoundStatus;
  winnerAccountId: string | null;
  /** Parsed option_map_json: poll option index → account ID, plus RoundMeta keys. */
  optionMap: Record<string, unknown>;
  resolutionPostedAt: string | null;
  resolutionJson: string | null;
};

/** A poll the bot posted and still has to resolve. */
export type OpenPoll = {
  gameId: string;
  round: number;
  pollId: string;
  optionMapJson: string;
};

type RoundRow = {
  number: number;
  status: RoundStatus;
  winner_account_id: string | null;
  option_map_json: string;
  resolution_posted_at: string | null;
  resolution_json: string | null;
};

const ROUND_COLUMNS = "number, status, winner_account_id, option_map_json, resolution_posted_at, resolution_json";

/** Parse `option_map_json`, tolerating a malformed or empty value. */
function parseOptionMap(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json || "{}");
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function mapRound(row: RoundRow): Round {
  return {
    number: row.number,
    status: row.status,
    winnerAccountId: row.winner_account_id,
    optionMap: parseOptionMap(row.option_map_json),
    resolutionPostedAt: row.resolution_posted_at,
    resolutionJson: row.resolution_json,
  };
}

export function roundMeta(round: Round | undefined): RoundMeta {
  return (round?.optionMap ?? {}) as RoundMeta;
}

/** Account IDs behind the round poll's options (the numeric keys of the option map). */
export function pollOptionAccounts(round: Round): string[] {
  return Object.entries(round.optionMap)
    .filter(([key]) => /^\d+$/.test(key))
    .map(([, id]) => id)
    .filter((id): id is string => typeof id === "string");
}

export function loadRound(db: Db, gameId: string, roundNumber: number): Round | undefined {
  const row = db
    .prepare(`SELECT ${ROUND_COLUMNS} FROM rounds WHERE game_id = ? AND number = ?`)
    .get(gameId, roundNumber) as RoundRow | undefined;
  return row ? mapRound(row) : undefined;
}

/** Every round of the game in play order — one query where a round-by-round loop would issue N. */
export function loadRounds(db: Db, gameId: string): Round[] {
  const rows = db
    .prepare(`SELECT ${ROUND_COLUMNS} FROM rounds WHERE game_id = ? ORDER BY number`)
    .all(gameId) as RoundRow[];
  return rows.map(mapRound);
}

/** Rounds that produced a winner (for the finale thread). */
export function loadRoundWinners(db: Db, gameId: string): { round: number; winnerAccountId: string }[] {
  return db
    .prepare(
      `SELECT number AS round, winner_account_id AS winnerAccountId FROM rounds
       WHERE game_id = ? AND winner_account_id IS NOT NULL ORDER BY number ASC`,
    )
    .all(gameId) as { round: number; winnerAccountId: string }[];
}

// ── announced: waiting on replacements, or posting ─────────

/** Open (or reopen) the round as `announced` with `meta`. */
export function openAnnouncedRound(db: Db, gameId: string, round: number, meta: RoundMeta): void {
  db.prepare(
    `INSERT OR REPLACE INTO rounds (game_id, number, status, option_map_json)
     VALUES (?, ?, 'announced', ?)`,
  ).run(gameId, round, JSON.stringify(meta));
}

export function updateAnnouncedRoundMeta(db: Db, gameId: string, round: number, meta: RoundMeta): void {
  db.prepare(
    "UPDATE rounds SET option_map_json = ? WHERE game_id = ? AND number = ? AND status = 'announced'",
  ).run(JSON.stringify(meta), gameId, round);
}

export function deleteAnnouncedRound(db: Db, gameId: string, round: number): void {
  db.prepare("DELETE FROM rounds WHERE game_id = ? AND number = ? AND status = 'announced'").run(gameId, round);
}

/** Announced rounds of open games: their replacement windows need re-checking. */
export function announcedRoundsOfOpenGames(db: Db): { gameId: string; round: number }[] {
  return db
    .prepare(
      `SELECT r.game_id AS gameId, r.number AS round FROM rounds r
       JOIN games g ON g.id = r.game_id
       WHERE r.status = 'announced' AND g.status ${NON_TERMINAL_STATUS_SQL}`,
    )
    .all() as { gameId: string; round: number }[];
}

// ── poll_open ───────────────────────────────────────────────

/**
 * Move an announced round to `poll_open`. `cleanupPending` flags a poll whose
 * game moved on while it was being posted. False when the round is no longer
 * announced.
 */
export function savePollRound(
  db: Db,
  gameId: string,
  round: number,
  poll: { pollStatusId: string; pollId: string; pollExpiresAt: string; optionMap: Record<string, string> },
  cleanupPending: boolean,
): boolean {
  const result = db.prepare(
    `UPDATE rounds SET status = 'poll_open', poll_status_id = ?, poll_id = ?, poll_expires_at = ?,
       option_map_json = ?, poll_cleanup_pending = ?
     WHERE game_id = ? AND number = ? AND status = 'announced'`,
  ).run(
    poll.pollStatusId,
    poll.pollId,
    poll.pollExpiresAt,
    JSON.stringify(poll.optionMap),
    cleanupPending ? 1 : 0,
    gameId,
    round,
  );
  return result.changes === 1;
}

export function isPollOpen(db: Db, gameId: string, round: number, pollId: string): boolean {
  return db
    .prepare("SELECT 1 FROM rounds WHERE game_id = ? AND number = ? AND status = 'poll_open' AND poll_id = ?")
    .get(gameId, round, pollId) !== undefined;
}

/** Open polls of open games that expired by `now`. */
export function duePolls(db: Db, now: Date): OpenPoll[] {
  return db
    .prepare(
      `SELECT r.game_id AS gameId, r.number AS round, r.poll_id AS pollId, r.option_map_json AS optionMapJson
       FROM rounds r JOIN games g ON g.id = r.game_id
       WHERE r.status = 'poll_open' AND r.poll_expires_at IS NOT NULL AND r.poll_expires_at <= ?
         AND g.status ${NON_TERMINAL_STATUS_SQL}`,
    )
    .all(now.toISOString()) as OpenPoll[];
}

/** The open poll posted as `statusId`, with its expiry. */
export function openPollByStatus(
  db: Db,
  statusId: string,
): (OpenPoll & { pollExpiresAt: string | null }) | null {
  const row = db
    .prepare(
      `SELECT game_id AS gameId, number AS round, poll_id AS pollId, option_map_json AS optionMapJson,
              poll_expires_at AS pollExpiresAt
       FROM rounds WHERE poll_status_id = ? AND status = 'poll_open'`,
    )
    .get(statusId) as (OpenPoll & { pollExpiresAt: string | null }) | undefined;
  return row ?? null;
}

/** An open poll under early-close watch: what the last look at its votes saw. */
export type WatchedPoll = OpenPoll & {
  pollStatusId: string;
  pollExpiresAt: string;
  pollDurationSec: number;
  watchedVotes: number | null;
  watchedTallyJson: string | null;
  votesChangedAt: string | null;
};

/** Open polls of open games that have not expired by `now`. */
export function unexpiredPolls(db: Db, now: Date): WatchedPoll[] {
  return db
    .prepare(
      `SELECT r.game_id AS gameId, r.number AS round, r.poll_id AS pollId, r.option_map_json AS optionMapJson,
              r.poll_status_id AS pollStatusId, r.poll_expires_at AS pollExpiresAt,
              r.watched_votes AS watchedVotes, r.watched_tally_json AS watchedTallyJson,
              r.votes_changed_at AS votesChangedAt, g.poll_duration_sec AS pollDurationSec
       FROM rounds r JOIN games g ON g.id = r.game_id
       WHERE r.status = 'poll_open' AND r.poll_expires_at IS NOT NULL AND r.poll_expires_at > ?
         AND g.status ${NON_TERMINAL_STATUS_SQL}`,
    )
    .all(now.toISOString()) as WatchedPoll[];
}

/** Record the votes seen on a watched poll and when they last changed. */
export function watchPollVotes(
  db: Db,
  poll: OpenPoll,
  seen: { totalVotes: number; tallyJson: string; changedAt: Date },
): void {
  db.prepare(
    `UPDATE rounds SET watched_votes = ?, watched_tally_json = ?, votes_changed_at = ?
     WHERE game_id = ? AND number = ? AND status = 'poll_open' AND poll_id = ?`,
  ).run(seen.totalVotes, seen.tallyJson, seen.changedAt.toISOString(), poll.gameId, poll.round, poll.pollId);
}

// ── decided ─────────────────────────────────────────────────

/** Resolve a polled round: its winner (null for a tie), merged meta and the result to post. */
export function markRoundResolved(
  db: Db,
  gameId: string,
  round: number,
  resolution: {
    winnerAccountId: string | null;
    metaPatch: RoundMeta;
    pollCleanupPending: boolean;
    resolutionJson: string;
  },
): void {
  const optionMap = { ...loadRound(db, gameId, round)?.optionMap, ...resolution.metaPatch };
  db.prepare(
    `UPDATE rounds SET status = 'resolved', winner_account_id = ?, option_map_json = ?,
       poll_cleanup_pending = ?, resolution_json = ?
      WHERE game_id = ? AND number = ?`,
  ).run(
    resolution.winnerAccountId,
    JSON.stringify(optionMap),
    resolution.pollCleanupPending ? 1 : 0,
    resolution.resolutionJson,
    gameId,
    round,
  );
}

/** Record a round decided without a poll (walkover / auto-tie). */
export function saveRoundWithoutPoll(
  db: Db,
  gameId: string,
  round: number,
  decided: {
    status: "walkover" | "auto_tied";
    winnerAccountId: string | null;
    meta: RoundMeta;
    resolutionJson: string;
  },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO rounds
      (game_id, number, status, winner_account_id, option_map_json, resolution_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(gameId, round, decided.status, decided.winnerAccountId, JSON.stringify(decided.meta), decided.resolutionJson);
}

export function markResolutionPosted(db: Db, gameId: string, round: number, at: Date): void {
  db.prepare(
    `UPDATE rounds SET resolution_posted_at = ?
     WHERE game_id = ? AND number = ? AND status IN (${placeholders(RESOLVED_ROUND_STATUSES)})`,
  ).run(at.toISOString(), gameId, round, ...RESOLVED_ROUND_STATUSES);
}

// ── poll cleanup ────────────────────────────────────────────

export type PollCleanup = {
  gameId: string;
  round: number;
  roundStatus: RoundStatus;
  pollStatusId: string | null;
  gameStatus: GameStatus;
};

/** Rounds whose poll must stop collecting votes: every open poll and every flagged cleanup. */
export function pollsNeedingCleanup(db: Db): PollCleanup[] {
  return db
    .prepare(
      `SELECT r.game_id AS gameId, r.number AS round, r.status AS roundStatus,
              r.poll_status_id AS pollStatusId, g.status AS gameStatus
       FROM rounds r JOIN games g ON g.id = r.game_id
       WHERE r.status = 'poll_open' OR r.poll_cleanup_pending = 1`,
    )
    .all() as PollCleanup[];
}

/** Forget a cleaned-up poll and resolve its round. False when another sweep already did. */
export function markPollCleanedUp(db: Db, gameId: string, round: number): boolean {
  return db
    .prepare(
      `UPDATE rounds SET status = 'resolved', poll_cleanup_pending = 0,
         poll_status_id = NULL, poll_id = NULL, poll_expires_at = NULL
       WHERE game_id = ? AND number = ? AND (status = 'poll_open' OR poll_cleanup_pending = 1)`,
    )
    .run(gameId, round).changes === 1;
}

/** Forget an early-closed poll whose status is gone; the round is already resolved. */
export function clearEarlyClosedPoll(db: Db, poll: OpenPoll): void {
  db.prepare(
    `UPDATE rounds SET poll_cleanup_pending = 0, poll_status_id = NULL, poll_id = NULL, poll_expires_at = NULL
     WHERE game_id = ? AND number = ? AND poll_id = ?`,
  ).run(poll.gameId, poll.round, poll.pollId);
}

export function openPollRounds(db: Db, gameId: string): { round: number; pollStatusId: string | null }[] {
  return db
    .prepare(
      "SELECT number AS round, poll_status_id AS pollStatusId FROM rounds WHERE game_id = ? AND status = 'poll_open'",
    )
    .all(gameId) as { round: number; pollStatusId: string | null }[];
}

/** Close a void game's poll round: resolved, with no poll left to tally. */
export function closePollRound(db: Db, gameId: string, round: number): void {
  db.prepare(
    `UPDATE rounds SET status = 'resolved', poll_status_id = NULL, poll_id = NULL, poll_expires_at = NULL
     WHERE game_id = ? AND number = ?`,
  ).run(gameId, round);
}
