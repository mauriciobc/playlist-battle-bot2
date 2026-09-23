import type { Db } from "../db/index.js";
import { normalizeYouTubeUrl } from "./normalize.js";

export class UnresolvableVideoError extends Error {
  override readonly name = "UnresolvableVideoError";
  readonly videoId: string;

  constructor(videoId: string, reason: string) {
    super(`Video ${videoId} is not playable: ${reason}`);
    this.videoId = videoId;
  }
}

export type ResolvedTune = {
  videoId: string;
  title: string;
  author: string | null;
  canonicalUrl: string;
};

export type ResolveOptions = {
  db: Db;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

const OEMBED_URL = "https://www.youtube.com/oembed";

/**
 * Resolve a video title via YouTube oEmbed (no API key), caching by video ID.
 * PRD §5.3 / §8.
 */
export async function resolveTitle(videoId: string, opts: ResolveOptions): Promise<ResolvedTune> {
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

  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${OEMBED_URL}?url=${encodeURIComponent(canonicalUrl)}&format=json`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(opts.requestTimeoutMs ?? 10_000),
    });
  } catch (err) {
    throw new UnresolvableVideoError(videoId, `oEmbed request failed: ${String(err)}`);
  }

  if (!res.ok) {
    throw new UnresolvableVideoError(videoId, `oEmbed returned HTTP ${res.status}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new UnresolvableVideoError(videoId, "oEmbed returned invalid JSON");
  }

  const title =
    typeof body === "object" && body !== null && typeof (body as { title?: unknown }).title === "string"
      ? (body as { title: string }).title
      : null;
  if (!title) {
    throw new UnresolvableVideoError(videoId, "oEmbed response has no title");
  }

  const author =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { author_name?: unknown }).author_name === "string"
      ? (body as { author_name: string }).author_name
      : null;

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
 * served from cache). Unavailable on 4xx except 429 (rate limited = fail-open);
 * network errors / 5xx / 429 also fail-open so transient blips don't forfeit
 * a round.
 */
export async function checkAvailable(
  videoId: string,
  opts: { fetchImpl?: typeof fetch; requestTimeoutMs?: number } = {},
): Promise<boolean> {
  const canonicalUrl = normalizeYouTubeUrl(videoId);
  if (!canonicalUrl) return false;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${OEMBED_URL}?url=${encodeURIComponent(canonicalUrl)}&format=json`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(opts.requestTimeoutMs ?? 10_000),
    });
  } catch {
    return true; // network error → fail-open
  }

  if (res.status === 429) return true;
  if (res.status >= 500) return true;
  if (res.status >= 400 && res.status < 500) return false;
  if (!res.ok) return true;

  try {
    const body: unknown = await res.json();
    const title =
      typeof body === "object" && body !== null && typeof (body as { title?: unknown }).title === "string"
        ? (body as { title: string }).title
        : null;
    return title !== null && title.length > 0;
  } catch {
    return true; // invalid JSON on 2xx → fail-open
  }
}
