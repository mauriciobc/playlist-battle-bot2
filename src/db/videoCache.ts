import type { Db } from "./index.js";

/** Video titles resolved through oEmbed, cached by video ID. */

export type CachedVideo = { title: string; author: string | null };

export function readCachedVideo(db: Db, videoId: string): CachedVideo | null {
  const row = db
    .prepare("SELECT title, author FROM video_cache WHERE video_id = ?")
    .get(videoId) as CachedVideo | undefined;
  return row ?? null;
}

export function cacheVideo(db: Db, videoId: string, video: CachedVideo, at: Date): void {
  db.prepare("INSERT OR REPLACE INTO video_cache (video_id, title, author, fetched_at) VALUES (?, ?, ?, ?)")
    .run(videoId, video.title, video.author, at.toISOString());
}
