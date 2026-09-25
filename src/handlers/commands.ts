/**
 * Command parsing for public mentions and DM replies.
 * Pure — receives plain text (already HTML-stripped by caller).
 * Error strings come from the active i18n catalog via `m()`.
 */

import { m } from "../i18n/index.js";
import { isValidPlaylistLength, MAX_CHALLENGERS } from "../game/types.js";

export type CreateCommand =
  | {
      theme: string;
      playlistLength: number;
      challengers: string[];
    }
  | { error: string };

/** `user` or `user@instance`. */
const HANDLE = "[A-Za-z0-9_]+(?:@[A-Za-z0-9.-]+)?";
const MENTION_RE = new RegExp(`@(${HANDLE})`, "g");
const LEADING_MENTIONS_RE = new RegExp(`^\\s*(@${HANDLE}\\s*)+`);
/** A challenger handle with an optional leading "@". */
const CHALLENGER_RE = new RegExp(`(^|\\s)@?(${HANDLE})`, "g");

function stripLeadingMentions(text: string): string {
  return text.replace(LEADING_MENTIONS_RE, "");
}

function extractMentions(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(MENTION_RE)) {
    if (match[1]) out.push(match[1]);
  }
  return out;
}

/** Local part of a handle (`alice` for `alice@other.social`). */
function localPart(handle: string): string {
  return handle.split("@")[0]!;
}

function mentionsBot(text: string, botAcct: string): boolean {
  const bot = botAcct.toLowerCase();
  return extractMentions(text).some((mention) => localPart(mention).toLowerCase() === bot);
}

/**
 * Handles in the challenger list, with or without a leading "@".
 *
 * Accepts "user", "user@instance" and "@user@instance". The mention-only
 * pattern dropped the local part of an unprefixed qualified handle, because
 * "@" appears inside "user@instance" and the capture began there.
 */
function extractChallengers(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(CHALLENGER_RE)) {
    const handle = match[2];
    if (!handle) continue;
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(handle);
  }
  return out;
}

/**
 * Challenger handles minus the bot itself: bare `@bot` and `@bot@<bot's
 * instance>` are dropped, while `@bot@other.instance` (a different person with
 * the same local part) stays.
 */
function challengersExceptBot(text: string, botAcct: string, instanceDomain?: string): string[] {
  const bot = botAcct.toLowerCase();
  const botQualified = instanceDomain ? `${bot}@${instanceDomain.toLowerCase()}` : bot;
  return extractChallengers(text).filter((handle) => {
    const lower = handle.toLowerCase();
    return lower !== bot && lower !== botQualified;
  });
}

/**
 * Split `<theme> <length> <challengers…>` into the theme and the text after it.
 * The theme is quoted, or else everything before the first standalone
 * playlist-length integer.
 */
function splitTheme(rest: string): { theme: string; remainder: string } | null {
  const quoted = rest.match(/^(["'])(.*?)\1\s*(.*)$/s);
  if (quoted) return { theme: quoted[2]!.trim(), remainder: quoted[3]!.trim() };

  // Lookahead ensures "90s" in a theme doesn't match as the length.
  const lengthMatch = rest.match(/(?:^|\s)(\d{1,2})(?=\s|$)/);
  if (!lengthMatch || lengthMatch.index === undefined) return null;
  const lengthStart = lengthMatch.index + lengthMatch[0].search(/\d/);
  return { theme: rest.slice(0, lengthStart).trim(), remainder: rest.slice(lengthStart).trim() };
}

/**
 * Parse: `@bot newgame "<theme>" <8-12> @ch1 [@ch2] [@ch3]`
 * Returns CreateCommand (ok or {error}) when the bot is mentioned with newgame,
 * or null when this text is not a create command for this bot.
 */
export function parseCreateCommand(text: string, botAcct: string, instanceDomain?: string): CreateCommand | null {
  if (!mentionsBot(text, botAcct)) return null;
  const command = stripLeadingMentions(text).trim();
  if (!/^newgame\b/i.test(command)) return null;

  const split = splitTheme(command.replace(/^newgame\b/i, "").trim());
  if (!split) return { error: m().cmdUsage() };
  if (!split.theme) return { error: m().cmdThemeRequired() };

  const lengthToken = split.remainder.match(/^(\d{1,2})\s*/);
  if (!lengthToken) return { error: m().cmdLengthRequired() };
  const playlistLength = Number(lengthToken[1]);
  if (!isValidPlaylistLength(playlistLength)) return { error: m().cmdLengthRange() };

  const challengers = challengersExceptBot(
    split.remainder.slice(lengthToken[0].length).trim(),
    botAcct,
    instanceDomain,
  );
  if (challengers.length === 0) return { error: m().cmdTagChallenger() };
  if (challengers.length > MAX_CHALLENGERS) return { error: m().cmdMaxChallengers() };
  const unique = new Set(challengers.map((c) => c.toLowerCase()));
  if (unique.size !== challengers.length) return { error: m().cmdDuplicateChallengers() };

  return { theme: split.theme, playlistLength, challengers };
}

export function parseStatusCommand(text: string, botAcct: string): boolean {
  if (!mentionsBot(text, botAcct)) return false;
  return /^(status|help)\b/i.test(stripLeadingMentions(text).trim());
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

  // Any URL counts here; the submission handler decides whether it is a YouTube video.
  const urls = t.match(URL_RE) ?? [];
  return urls.length > 0 ? { kind: "links", urls } : { kind: "unknown" };
}

/** Remove HTML tags and decode the few entities Mastodon uses in status content.
 * `&amp;` is decoded last so `&amp;lt;` renders as the literal text `&lt;` rather
 * than double-decoding to `<`. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/g, "\n\n")
    // Preserve Mastodon mention structure: the @ is outside <span> inside <a class="mention">
    // Convert <a ...class="...mention...">@<span>user@domain</span></a> → @user@domain
    .replace(/<a[^>]*class="[^"]*mention[^"]*"[^>]*>@?<span[^>]*>([^<]+)<\/span><\/a>/gi, "@$1")
    .replace(/<a[^>]*class="[^"]*mention[^"]*"[^>]*>([^<]+)<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}
