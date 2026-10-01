/** PRD §8: all generated content fits within 500 characters. */

export const POST_LIMIT = 500;
const POLL_OPTION_LIMIT = 25;

/** Truncate to max chars (counted as UTF-16 code units) with an ellipsis. */
export function truncate(text: string, max: number = POST_LIMIT): string {
  if (text.length <= max) return text;
  if (max <= 1) return "…".slice(0, max);
  return `${text.slice(0, max - 1)}…`;
}

/** `A`, `B`, … `Z`, then `AA`, `AB`… — blind label for the n-th tune of a round. */
export function tuneLabel(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Build a ≤25-char poll option: "<label>: <abbrev tune>". */
export function abbreviatePollOption(label: string, title: string): string {
  const sep = ": ";
  const budget = POLL_OPTION_LIMIT - label.length - sep.length;
  if (budget <= 1) return truncate(label, POLL_OPTION_LIMIT);
  return `${label}${sep}${truncate(title.trim() || "—", budget)}`;
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
