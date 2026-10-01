/**
 * Command parsing for public mentions and DM replies.
 * Pure — receives plain text (already HTML-stripped by caller).
 * Error strings come from the active i18n catalog via `m()`.
 */

import { m } from "../i18n/index.js";
import { isValidPlaylistLength, MAX_CHALLENGERS } from "../game/types.js";
import { canonicalAcct, parseAcct, qualifyMentions, sameAccount, type StatusMention } from "../mastodon/handle.js";

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

/**
 * Whether a written mention is the bot. `@bot@other.social` is someone else
 * with the same local part, so once the instance is known only a bare `@bot`
 * or `@bot@<this instance>` counts.
 */
function mentionsBot(text: string, botAcct: string, instanceDomain?: string): boolean {
  const bot = botAcct.toLowerCase();
  return extractMentions(text).some((written) => {
    const { user, domain } = parseAcct(written, instanceDomain);
    return user.toLowerCase() === bot && (instanceDomain === undefined || domain === null);
  });
}

/**
 * Handles in the challenger list, with or without a leading "@".
 *
 * Accepts "user", "user@instance" and "@user@instance". The mention-only
 * pattern dropped the local part of an unprefixed qualified handle, because
 * "@" appears inside "user@instance" and the capture began there.
 */
function extractChallengers(text: string, instanceDomain?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(CHALLENGER_RE)) {
    if (!match[2]) continue;
    // `bob` and `bob@<this instance>` are one account: keep the canonical form.
    const handle = canonicalAcct(match[2], instanceDomain);
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
  return extractChallengers(text, instanceDomain).filter((handle) => !sameAccount(handle, botAcct, instanceDomain));
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
 * Command words, English first with their pt-br equivalents. Each must end the
 * word ("cancelar" is a command, "cancelamento" is prose), and the end test is
 * Unicode-aware because `\b` treats accented letters as non-word characters.
 */
const NEWGAME_WORD = /^(?:newgame|novojogo|novo\s+jogo)(?![\p{L}\p{N}])/iu;
const STATUS_WORD = /^(?:status|help|ajuda)(?![\p{L}\p{N}])/iu;
const ACCEPT_WORD = /^(?:accept|aceitar|aceito)(?![\p{L}\p{N}])/iu;
const DECLINE_WORD = /^(?:decline|recusar|recuso)(?![\p{L}\p{N}])/iu;
const CANCEL_WORD = /^(?:cancel|cancelar)(?![\p{L}\p{N}])/iu;

/**
 * Parse: `@bot newgame "<theme>" <8-12> @ch1 [@ch2] [@ch3]`
 * Returns CreateCommand (ok or {error}) when the bot is mentioned with newgame,
 * or null when this text is not a create command for this bot.
 */
export function parseCreateCommand(
  text: string,
  botAcct: string,
  instanceDomain?: string,
  mentions: readonly StatusMention[] = [],
): CreateCommand | null {
  if (!mentionsBot(text, botAcct, instanceDomain)) return null;
  const command = stripLeadingMentions(text).trim();
  if (!NEWGAME_WORD.test(command)) return null;

  const split = splitTheme(command.replace(NEWGAME_WORD, "").trim());
  if (!split) return { error: m().cmdUsage() };
  if (!split.theme) return { error: m().cmdThemeRequired() };

  const lengthToken = split.remainder.match(/^(\d{1,2})\s*/);
  if (!lengthToken) return { error: m().cmdLengthRequired() };
  const playlistLength = Number(lengthToken[1]);
  if (!isValidPlaylistLength(playlistLength)) return { error: m().cmdLengthRange() };

  // Rendered text drops a remote mention's domain; the status's mentions array keeps it.
  const written = qualifyMentions(split.remainder.slice(lengthToken[0].length).trim(), mentions, instanceDomain);
  const challengers = challengersExceptBot(written, botAcct, instanceDomain);
  if (challengers.length === 0) return { error: m().cmdTagChallenger() };
  if (challengers.length > MAX_CHALLENGERS) return { error: m().cmdMaxChallengers() };
  const unique = new Set(challengers.map((c) => c.toLowerCase()));
  if (unique.size !== challengers.length) return { error: m().cmdDuplicateChallengers() };

  return { theme: split.theme, playlistLength, challengers };
}

export function parseStatusCommand(text: string, botAcct: string, instanceDomain?: string): boolean {
  if (!mentionsBot(text, botAcct, instanceDomain)) return false;
  return STATUS_WORD.test(stripLeadingMentions(text).trim());
}

/**
 * "ranking" or "classificação", as a whole word. The accents are optional on
 * purpose ("classificacao", "classificaçao"), but a longer word that merely
 * starts with them ("rankings of the 80s") is not the command.
 */
const RANKING_WORD = /^(ranking|classifica[cç][aã]o)(?![\p{L}\p{N}])/iu;

/** `@bot ranking` / `@bot badges` — pull the board or a player's record. */
export function parseMeritCommand(text: string, botAcct: string, instanceDomain?: string): "ranking" | "badges" | null {
  if (!mentionsBot(text, botAcct, instanceDomain)) return null;
  const rest = stripLeadingMentions(text).trim();
  if (/^ranking\b/i.test(rest)) return "ranking";
  if (/^(badges|conquistas|achievements)\b/i.test(rest)) return "badges";
  if (RANKING_WORD.test(rest)) return "ranking";
  return null;
}

export type DmReply =
  | { kind: "accept" }
  | { kind: "decline" }
  | { kind: "cancel" }
  | { kind: "links"; urls: string[] }
  | { kind: "replace"; position: number; url: string }
  | { kind: "ranking" }
  | { kind: "badges" }
  | { kind: "unknown" };

/** One URL per match: a second `http(s)://` ends the first, so `a,https://b` is two links. */
const URL_RE = /https?:\/\/(?:(?!https?:\/\/)[^\s<>"'])+/gi;
/** Punctuation that follows a link in prose ("…watch?v=x, then…") rather than belonging to it. */
const TRAILING_PUNCTUATION_RE = /[.,;:!?)\]}]+$/;

function extractUrls(text: string): string[] {
  return (text.match(URL_RE) ?? []).map((url) => url.replace(TRAILING_PUNCTUATION_RE, "")).filter((url) => /^https?:\/\/./i.test(url));
}

/** v1.1 1.6: `replace <n> <url>` (pt-br: `trocar`/`substituir`) — case-insensitive, position 1..99. */
const REPLACE_RE = /^(?:replace|trocar|substituir)\s+(\d{1,2})\s+(https?:\/\/\S+)/i;

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
  if (ACCEPT_WORD.test(t)) return { kind: "accept" };
  if (DECLINE_WORD.test(t)) return { kind: "decline" };
  if (CANCEL_WORD.test(t)) return { kind: "cancel" };
  // Match the stem rather than enumerating accents: "classificação",
  // "classificacao" and "classificaçao" are all the same word to a player whose
  // keyboard dropped a diacritic.
  if (RANKING_WORD.test(t)) return { kind: "ranking" };
  if (/^(badges|conquistas)\b/i.test(t)) return { kind: "badges" };

  const replace = t.match(REPLACE_RE);
  if (replace) {
    return { kind: "replace", position: Number(replace[1]), url: replace[2]! };
  }

  // Any URL counts here; the submission handler decides whether it is a YouTube video.
  const urls = extractUrls(t);
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
