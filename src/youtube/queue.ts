/**
 * Anonymous battle queue link.
 *
 * YouTube's undocumented `watch_videos` endpoint turns a list of video IDs into
 * a temporary playlist and 303-redirects to `watch?v=<first>&list=TLGG…`, which
 * oEmbeds like any other video — so Mastodon renders a card. No account, no API
 * key, no quota, but nothing is saved either: the `TLGG` token is minted per
 * request, so the resolved link is persisted by the finale workflow before posting.
 */

const WATCH_VIDEOS_ENDPOINT = "https://www.youtube.com/watch_videos";
const WATCH_URL_PREFIX = "https://www.youtube.com/watch?";
const LIST_QUERY = "list=";

/**
 * A single tune is not a queue — that tune already gets its own finale post
 * (PRD §5.7), so one-tune battles publish no link at all.
 */
export const MIN_QUEUE_TUNES = 2;

/** Request URL for the anonymous queue of `videoIds`, in play order. */
export function watchVideosUrl(videoIds: string[]): string {
  return `${WATCH_VIDEOS_ENDPOINT}?video_ids=${videoIds.join(",")}`;
}

/**
 * Resolve `videoIds` into a shareable queue URL, or null when YouTube does not
 * answer with a playlist redirect. A finale must still post without the link,
 * so this never throws.
 */
export async function resolveQueueUrl(
  videoIds: string[],
  opts: { fetchImpl?: typeof fetch; requestTimeoutMs?: number } = {},
): Promise<string | null> {
  if (videoIds.length < MIN_QUEUE_TUNES) return null;

  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(watchVideosUrl(videoIds), {
      redirect: "manual",
      signal: AbortSignal.timeout(opts.requestTimeoutMs ?? 10_000),
    });
    const location = res.headers.get("location");
    if (!location || !location.startsWith(WATCH_URL_PREFIX) || !location.includes(LIST_QUERY)) {
      return null;
    }
    return location;
  } catch {
    return null;
  }
}
