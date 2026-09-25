import type { Db } from "../db/index.js";
import { normalizeYouTubeUrl } from "./normalize.js";

class UnresolvableVideoError extends Error {
  override readonly name = "UnresolvableVideoError";

  constructor(videoId: string, reason: string) {
    super(`Video ${videoId} is not playable: ${reason}`);
  }
}

export type ResolvedTune = {
  videoId: string;
  title: string;
  author: string | null;
  canonicalUrl: string;
};

/** YouTube oEmbed (no API key) for a canonical watch URL. */
function fetchOembed(canonicalUrl: string, fetchImpl: typeof fetch = fetch): Promise<Response> {
  return fetchImpl(`https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
}

/** Title (null when missing/empty) and author of an oEmbed response; throws on invalid JSON. */
async function readOembed(res: Response): Promise<{ title: string | null; author: string | null }> {
  const body = (await res.json()) as { title?: unknown; author_name?: unknown } | null;
  return {
    title: typeof body?.title === "string" && body.title ? body.title : null,
    author: typeof body?.author_name === "string" ? body.author_name : null,
  };
}

/**
 * Resolve a video title via YouTube oEmbed, caching by video ID.
 * PRD §5.3 / §8.
 */
export async function resolveTitle(
  videoId: string,
  opts: { db: Db; fetchImpl?: typeof fetch },
): Promise<ResolvedTune> {
  const canonicalUrl = normalizeYouTubeUrl(videoId);
  if (!canonicalUrl) {
    throw new UnresolvableVideoError(videoId, "invalid video ID");
  }

  const cached = opts.db
    .prepare("SELECT title, author FROM video_cache WHERE video_id = ?")
    .get(videoId) as { title: string; author: string | null } | undefined;
  if (cached) {
    return { videoId, title: cached.title, author: cached.author, canonicalUrl };
  }

  let res: Response;
  try {
    res = await fetchOembed(canonicalUrl, opts.fetchImpl);
  } catch (err) {
    throw new UnresolvableVideoError(videoId, `oEmbed request failed: ${String(err)}`);
  }
  if (!res.ok) {
    throw new UnresolvableVideoError(videoId, `oEmbed returned HTTP ${res.status}`);
  }

  let body: { title: string | null; author: string | null };
  try {
    body = await readOembed(res);
  } catch {
    throw new UnresolvableVideoError(videoId, "oEmbed returned invalid JSON");
  }
  const { title, author } = body;
  if (!title) {
    throw new UnresolvableVideoError(videoId, "oEmbed response has no title");
  }

  opts.db
    .prepare(
      "INSERT OR REPLACE INTO video_cache (video_id, title, author, fetched_at) VALUES (?, ?, ?, ?)",
    )
    .run(videoId, title, author, new Date().toISOString());

  return { videoId, title, author, canonicalUrl };
}

/**
 * v1.1 1.4: live availability check for a video when preparing a round.
 * Always hits oEmbed — never reads video_cache (negative results must not be
 * served from cache). Only a definite 4xx other than 429 means unavailable;
 * network errors, 5xx, 429 and unparsable bodies fail open so transient blips
 * don't forfeit a round.
 */
export async function checkAvailable(
  videoId: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const canonicalUrl = normalizeYouTubeUrl(videoId);
  if (!canonicalUrl) return false;
  try {
    const res = await fetchOembed(canonicalUrl, opts.fetchImpl);
    if (res.status >= 400 && res.status < 500 && res.status !== 429) return false;
    if (!res.ok) return true;
    return (await readOembed(res)).title !== null;
  } catch {
    return true;
  }
}
