/**
 * Anonymous battle queue link.
 *
 * YouTube's undocumented `watch_videos` endpoint turns a list of video IDs into
 * a temporary playlist and 303-redirects to `watch?v=<first>&list=TLGG…`, which
 * oEmbeds like any other video — so Mastodon renders a card. No account, no API
 * key, no quota, but nothing is saved either: the `TLGG` token is minted per
 * request, so the resolved link is persisted by the finale workflow before posting.
 */

const QUEUE_TIMEOUT_MS = 10_000;

/**
 * Resolve `videoIds` (in play order) into a shareable queue URL, or null when
 * YouTube does not answer with a playlist redirect. A finale must still post
 * without the link, so this never throws.
 */
export async function resolveQueueUrl(
  videoIds: string[],
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  try {
    // A followed redirect would return the final page instead of the URL.
    const res = await (opts.fetchImpl ?? fetch)(
      `https://www.youtube.com/watch_videos?video_ids=${videoIds.join(",")}`,
      { redirect: "manual", signal: AbortSignal.timeout(QUEUE_TIMEOUT_MS) },
    );
    const location = res.headers.get("location");
    return location?.startsWith("https://www.youtube.com/watch?") && location.includes("list=")
      ? location
      : null;
  } catch {
    return null;
  }
}
