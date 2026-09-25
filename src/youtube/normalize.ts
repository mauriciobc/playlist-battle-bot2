const ALLOWED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** Extract the canonical 11-char YouTube video ID, or null if not a playable YouTube URL. */
export function extractVideoId(raw: string): string | null {
  const input = raw.trim();

  // Bare 11-char ID
  if (VIDEO_ID_RE.test(input)) return input;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) return null;

  const host = url.hostname.toLowerCase();

  // youtu.be/<id>
  if (host === "youtu.be" || host === "www.youtu.be") {
    const id = url.pathname.slice(1).split("/")[0] ?? "";
    return VIDEO_ID_RE.test(id) ? id : null;
  }

  // path-based: /shorts/<id>, /embed/<id>, /live/<id>, /v/<id>
  const pathMatch = url.pathname.match(/^\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
  if (pathMatch?.[2]) return pathMatch[2];

  // watch?v=<id> (also music.youtube.com)
  const v = url.searchParams.get("v");
  if (v && VIDEO_ID_RE.test(v)) return v;

  return null;
}

/** Normalize any supported YouTube URL to canonical https://www.youtube.com/watch?v=ID. */
export function normalizeYouTubeUrl(raw: string): string | null {
  const id = extractVideoId(raw);
  return id ? `https://www.youtube.com/watch?v=${id}` : null;
}
