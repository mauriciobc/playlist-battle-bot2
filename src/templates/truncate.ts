/** PRD §8: all generated content fits within 500 characters. */

export const POST_LIMIT = 500;
export const POLL_OPTION_LIMIT = 25;

/** Truncate a title to max chars (counted as UTF-16 code units) with ellipsis. */
export function truncateTitle(title: string, max: number = POLL_OPTION_LIMIT): string {
  if (title.length <= max) return title;
  if (max <= 1) return "…".slice(0, max);
  return `${title.slice(0, max - 1)}…`;
}

/**
 * Build a ≤25-char poll option: "<player>: <abbrev tune>".
 * Player name gets priority; remaining budget goes to the title.
 */
export function abbreviatePollOption(playerName: string, title: string): string {
  const name = playerName.trim() || "?";
  if (name.length >= POLL_OPTION_LIMIT) return truncateTitle(name, POLL_OPTION_LIMIT);
  const sep = ": ";
  const budget = POLL_OPTION_LIMIT - name.length - sep.length;
  if (budget <= 1) return truncateTitle(name, POLL_OPTION_LIMIT);
  const tune = truncateTitle(title.trim() || "—", budget);
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
          : `${truncateTitle(base, POLL_OPTION_LIMIT - suffix.length)}${suffix}`;
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

export function truncatePost(text: string, max: number = POST_LIMIT): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return "…";
  return `${text.slice(0, max - 1)}…`;
}

export function truncatePostWithSuffix(
  prefix: string,
  suffix: string,
  max: number = POST_LIMIT,
): string {
  const separator = "\n";
  const available = max - suffix.length - separator.length;
  if (available <= 0) return truncatePost(suffix, max);
  return `${truncatePost(prefix, available)}${separator}${suffix}`;
}

export class PostTooLongError extends Error {
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
