import type { Db } from "./index.js";
import type { Tune, TuneDraft } from "../game/types.js";

/** Tunes table: each player's playlist, one row per position. */

function mapTune(r: Record<string, unknown>): Tune {
  return {
    accountId: r.account_id as string,
    position: r.position as number,
    videoId: r.video_id as string,
    title: r.title as string,
    canonicalUrl: r.canonical_url as string,
  };
}

/** Every tune of the game in play order. */
export function loadTunes(db: Db, gameId: string): Tune[] {
  const rows = db
    .prepare("SELECT * FROM tunes WHERE game_id = ? ORDER BY position, account_id")
    .all(gameId) as Record<string, unknown>[];
  return rows.map(mapTune);
}

/** Append a resolved tune to a player's playlist (position comes from the engine). */
export function insertTune(db: Db, gameId: string, t: Tune): void {
  db.prepare(
    `INSERT INTO tunes (game_id, account_id, position, video_id, title, canonical_url)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(gameId, t.accountId, t.position, t.videoId, t.title, t.canonicalUrl);
}

/** Swap the video at a player's playlist position. */
export function replaceTune(db: Db, gameId: string, accountId: string, position: number, tune: TuneDraft): void {
  db.prepare(
    `UPDATE tunes SET video_id = ?, title = ?, canonical_url = ?
     WHERE game_id = ? AND account_id = ? AND position = ?`,
  ).run(tune.videoId, tune.title, tune.canonicalUrl, gameId, accountId, position);
}
