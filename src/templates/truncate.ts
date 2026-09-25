/** PRD §8: all generated content fits within 500 characters. */

export const POST_LIMIT = 500;
const POLL_OPTION_LIMIT = 25;

/** Truncate to max chars (counted as UTF-16 code units) with an ellipsis. */
export function truncate(text: string, max: number = POST_LIMIT): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…".slice(0, max);
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Build a ≤25-char poll option: "<player>: <abbrev tune>".
 * Player name gets priority; remaining budget goes to the title.
 */
export function abbreviatePollOption(playerName: string, title: string): string {
  const name = playerName.trim() || "?";
  if (name.length >= POLL_OPTION_LIMIT) return truncate(name, POLL_OPTION_LIMIT);
  const sep = ": ";
  const budget = POLL_OPTION_LIMIT - name.length - sep.length;
  if (budget <= 1) return truncate(name, POLL_OPTION_LIMIT);
  const tune = truncate(title.trim() || "—", budget);
  return `${name}${sep}${tune}`;
}

/**
 * Mastodon rejects polls whose options are not unique
 * (PollOptionsValidator: `duplicate_options` → HTTP 422).
 * Truncation to 25 chars can collide (same display name, same video title),
 * so disambiguate repeats with a ` #n` suffix while staying ≤25 chars.
 */
export function dedupePollOptions(options: string[]): string[] {
  const seen = new Set<string>();
  return options.map((raw) => {
    const base = raw.trim();
    if (!seen.has(base)) {
      seen.add(base);
      return base;
    }
    let n = 2;
    for (;;) {
      const suffix = ` #${n}`;
      const candidate =
        base.length + suffix.length <= POLL_OPTION_LIMIT
          ? `${base}${suffix}`
          : `${truncate(base, POLL_OPTION_LIMIT - suffix.length)}${suffix}`;
      if (!seen.has(candidate)) {
        seen.add(candidate);
        return candidate;
      }
      n += 1;
    }
  });
}

/**
 * Mastodon attaches a link preview card from the FIRST http(s) URL in the
 * status text (FetchLinkCardService::parse_urls) and our tune posts rely on
 * that card for the YouTube embed (type=video via YouTube oEmbed).
 * A video title can itself contain an `https://…` string, which would steal
 * the card. Break URL detection inside displayed titles so the canonical
 * YouTube URL stays the first (only) link. The zero-width space is invisible
 * in clients but stops Mastodon's URL regex from matching.
 */
export function sanitizeTitleForPost(title: string): string {
  const ZWSP = String.fromCharCode(0x200b);
  return title.split("://").join(":" + ZWSP + "//");
}

export function truncatePostWithSuffix(
  prefix: string,
  suffix: string,
  max: number = POST_LIMIT,
): string {
  const separator = "\n";
  const available = max - suffix.length - separator.length;
  if (available <= 0) return truncate(suffix, max);
  return `${truncate(prefix, available)}${separator}${suffix}`;
}

class PostTooLongError extends Error {
  override readonly name = "PostTooLongError";
  readonly length: number;

  constructor(length: number) {
    super(`Post is ${length} characters; limit is ${POST_LIMIT}`);
    this.length = length;
  }
}

export function assertPostLength(text: string): void {
  if (text.length > POST_LIMIT) throw new PostTooLongError(text.length);
}
