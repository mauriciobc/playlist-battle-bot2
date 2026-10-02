import type { Logger } from "../logger.js";
import type { MastodonClient } from "./client.js";

/**
 * The one place a Mastodon account becomes an `@mention`, and a typed or
 * reported handle becomes an identity.
 *
 * Mastodon reports `acct` relative to the instance the bot runs on: a bare
 * `alice` for a local account, `alice@remote.social` for a federated one. A
 * hand-typed `@alice@home.example` can also carry the bot's own domain, so
 * every handle is normalised against `instanceDomain` before it is compared,
 * stored or printed. Without an instance domain only the written form is known,
 * so nothing is treated as local unless it is bare.
 */

/** Numeric account IDs are not valid mentions; they pass through untouched. */
const ACCOUNT_ID_PATTERN = /^\d+$/;

type AcctParts = {
  user: string;
  /** Lower-cased; null when the account lives on the bot's instance. */
  domain: string | null;
};

/** Split a handle (with or without a leading "@") into user and foreign domain. */
export function parseAcct(acct: string, instanceDomain?: string): AcctParts {
  const handle = acct.trim().replace(/^@/, "");
  const at = handle.lastIndexOf("@");
  if (at <= 0) return { user: handle, domain: null };

  const domain = handle.slice(at + 1).toLowerCase();
  const isLocal = domain === "" || domain === instanceDomain?.toLowerCase();
  return { user: handle.slice(0, at), domain: isLocal ? null : domain };
}

/** Stored and compared form: `alice` for a local account, `alice@remote.social` otherwise. */
export function canonicalAcct(acct: string, instanceDomain?: string): string {
  const { user, domain } = parseAcct(acct, instanceDomain);
  return domain ? `${user}@${domain}` : user;
}

/** Usernames are case-insensitive on Mastodon, so `@Bob` and `@bob@home.example` are one account. */
export function sameAccount(a: string, b: string, instanceDomain?: string): boolean {
  return canonicalAcct(a, instanceDomain).toLowerCase() === canonicalAcct(b, instanceDomain).toLowerCase();
}

/**
 * `@alice` for a local account (a bare username resolves on the posting
 * instance), `@alice@remote.social` for a remote one. Posts and DMs alike.
 */
export function mention(acct: string, instanceDomain?: string): string {
  const handle = acct.trim().replace(/^@/, "");
  if (ACCOUNT_ID_PATTERN.test(handle)) return `@${handle}`;

  const { user, domain } = parseAcct(acct, instanceDomain);
  return domain ? `@${user}@${domain}` : `@${user}`;
}

/** The mentions array Mastodon attaches to a status (REST::MentionSerializer). */
export type StatusMention = { username: string; acct: string };

/** Mastodon's `Account::MENTION_RE`: an `@` not glued to a preceding word character, `=` or `/`. */
const TEXT_MENTION_RE = /(?<![=/\w])@([A-Za-z0-9_]+)(?:@([A-Za-z0-9.-]+))?/g;

/**
 * Put back the domain Mastodon's rendered HTML drops. A remote mention shows as
 * `@jacky` in the content, yet the status's `mentions` array says
 * `jacky@other.social`; parsing the text alone cannot tell it from a local
 * `@jacky`. `mentions` comes in text order (`ordered_mentions` sorts by id), so
 * each mention in the text takes the next unused entry with that username, and
 * is rewritten to its canonical form (`@bob` for a local account,
 * `@jacky@other.social` for a remote one). Mastodon stores a mention of the same
 * account once, so a repeat reuses its entry. A mention with no matching entry
 * is left as written.
 */
export function qualifyMentions(text: string, mentions: readonly StatusMention[], instanceDomain?: string): string {
  const pool = mentions.map((m, i) => ({
    i,
    username: m.username.toLowerCase(),
    acct: canonicalAcct(m.acct, instanceDomain),
  }));
  const consumed = new Set<number>();
  return text.replace(TEXT_MENTION_RE, (written: string, user: string, domain: string | undefined) => {
    const typed = domain ? canonicalAcct(`${user}@${domain}`, instanceDomain).toLowerCase() : null;
    const candidates = pool.filter((p) => p.username === user.toLowerCase());
    const hit =
      (typed && candidates.find((p) => p.acct.toLowerCase() === typed)) ||
      candidates.find((p) => !consumed.has(p.i)) ||
      candidates[0];
    if (!hit) return written;
    consumed.add(hit.i);
    return `@${hit.acct}`;
  });
}

/**
 * The domain whose accounts Mastodon reports bare. Once resolved at boot this is
 * the instance's own domain; until then the API host is the best guess.
 */
export function instanceDomainOf(client: MastodonClient): string | undefined {
  // Test doubles and partially built clients may carry no base URL.
  return client.localDomain ?? (client.baseUrl ? new URL(client.baseUrl).hostname : undefined);
}

/**
 * Ask the instance which domain its accounts live on (`/api/v2/instance`
 * `domain`, Mastodon's LOCAL_DOMAIN) and remember it on the client. That is not
 * always the API host: LOCAL_DOMAIN and WEB_DOMAIN can differ. A server that
 * cannot answer falls back to the API host.
 */
export async function resolveLocalDomain(client: MastodonClient, log?: Logger): Promise<string> {
  let domain: string | undefined;
  try {
    domain = (await client.get<{ domain?: string }>("/api/v2/instance")).domain?.trim().toLowerCase() || undefined;
  } catch (err) {
    log?.warn({ err: err instanceof Error ? err.message : String(err) }, "could not read the instance domain; using the API host");
  }
  client.localDomain = domain ?? new URL(client.baseUrl).hostname.toLowerCase();
  return client.localDomain;
}
