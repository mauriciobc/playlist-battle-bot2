/**
 * Command parsing for public mentions and DM replies.
 * Pure — receives plain text (already HTML-stripped by caller).
 * Error strings come from the active i18n catalog via `m()`.
 */

import { m } from "../i18n/index.js";

export type CreateCommand =
  | {
      theme: string;
      playlistLength: number;
      challengers: string[];
    }
  | { error: string };

const MENTION_RE = /@([A-Za-z0-9_]+(?:@[A-Za-z0-9.-]+)?)/g;

function stripLeadingMentions(text: string): string {
  return text.replace(/^\s*(@[A-Za-z0-9_]+(?:@[A-Za-z0-9.-]+)?\s*)+/, "");
}

function extractMentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** Local part of a handle (`alice` for `alice@other.social`). */
function localPart(handle: string): string {
  return handle.split("@")[0]!;
}

/**
 * Parse: `@bot newgame "<theme>" <8-12> @ch1 [@ch2] [@ch3]`
 * Returns CreateCommand (ok or {error}) when the bot is mentioned with newgame,
 * or null when this text is not a create command for this bot.
 */
export function parseCreateCommand(text: string, botAcct: string): CreateCommand | null {
  const mentions = extractMentions(text);
  if (!mentions.some((m) => localPart(m).toLowerCase() === botAcct.toLowerCase())) return null;

  const withoutMentions = stripLeadingMentions(text);
  // Also drop mid-text bot mentions
  const cleaned = withoutMentions
    .replace(new RegExp(`@${botAcct}(?:@[A-Za-z0-9.-]+)?`, "gi"), "")
    .trim();

  if (!/^newgame\b/i.test(cleaned)) return null;

  const rest = cleaned.replace(/^newgame\b/i, "").trim();

  // Theme: quoted or unquoted-before-length
  let theme: string;
  let remainder: string;

  const quoted = rest.match(/^(["'])(.*?)\1\s*(.*)$/s);
  if (quoted) {
    theme = quoted[2]!.trim();
    remainder = quoted[3]!.trim();
  } else {
    // Unquoted: theme is everything before the first standalone playlist-length integer.
    // Lookahead ensures "90s" in a theme doesn't match as length.
    const lenMatch = rest.match(/(?:^|\s)(\d{1,2})(?=\s|$)/);
    if (!lenMatch || lenMatch.index === undefined) {
      return { error: m().cmdUsage() };
    }
    const absNumStart = lenMatch.index + lenMatch[0].search(/\d/);
    theme = rest.slice(0, absNumStart).trim();
    remainder = rest.slice(absNumStart).trim();
  }

  if (!theme) {
    return { error: m().cmdThemeRequired() };
  }

  const lenTok = remainder.match(/^(\d{1,2})\s*/);
  if (!lenTok) {
    return { error: m().cmdLengthRequired() };
  }
  const playlistLength = Number(lenTok[1]);
  const afterLen = remainder.slice(lenTok[0].length).trim();

  if (playlistLength < 8 || playlistLength > 12) {
    return { error: m().cmdLengthRange() };
  }

  const challengers = extractMentions(afterLen).filter(
    (c) => localPart(c).toLowerCase() !== botAcct.toLowerCase(),
  );

  if (challengers.length === 0) {
    return { error: m().cmdTagChallenger() };
  }
  if (challengers.length > 3) {
    return { error: m().cmdMaxChallengers() };
  }
  const unique = new Set(challengers.map((c) => c.toLowerCase()));
  if (unique.size !== challengers.length) {
    return { error: m().cmdDuplicateChallengers() };
  }

  return { theme, playlistLength, challengers };
}

export function parseStatusCommand(text: string, botAcct: string): boolean {
  const mentions = extractMentions(text);
  if (!mentions.some((m) => localPart(m).toLowerCase() === botAcct.toLowerCase())) return false;
  const rest = stripLeadingMentions(text).trim();
  return /^(status|help)\b/i.test(rest);
}

export type DmReply =
  | { kind: "accept" }
  | { kind: "decline" }
  | { kind: "cancel" }
  | { kind: "links"; urls: string[] }
  | { kind: "replace"; position: number; url: string }
  | { kind: "unknown" };

const URL_RE = /https?:\/\/[^\s<>"']+/gi;
/** v1.1 1.6: `replace <n> <url>` — case-insensitive, position 1..99. */
const REPLACE_RE = /^replace\s+(\d{1,2})\s+(https?:\/\/\S+)/i;

/**
 * Mastodon DMs almost always start with `@bot` (reply prefix or compose mention).
 * Strip leading mentions + zero-width chars so `@bot accept` parses as `accept`.
 */
function normalizeDmText(text: string): string {
  const noZw = text.replace(/[\u200B-\u200D\uFEFF]/g, "");
  return stripLeadingMentions(noZw.trim()).trim();
}

export function parseDmReply(text: string): DmReply {
  const t = normalizeDmText(text);
  if (/^accept\b/i.test(t)) return { kind: "accept" };
  if (/^decline\b/i.test(t)) return { kind: "decline" };
  if (/^cancel\b/i.test(t)) return { kind: "cancel" };

  const replace = t.match(REPLACE_RE);
  if (replace) {
    return { kind: "replace", position: Number(replace[1]), url: replace[2]! };
  }

  const urls = t.match(URL_RE) ?? [];
  if (urls.length > 0) {
    // Keep only youtube-ish candidates; validation happens downstream
    return { kind: "links", urls };
  }
  return { kind: "unknown" };
}

/** Remove HTML tags and decode the few entities Mastodon uses in status content.
 * `&amp;` is decoded last so `&amp;lt;` renders as the literal text `&lt;` rather
 * than double-decoding to `<`. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/g, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}
