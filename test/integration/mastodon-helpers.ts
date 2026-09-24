/**
 * Thin Mastodon API helpers for integration tests.
 *
 * Uses raw fetch — no external deps needed. Supports:
 * - Post a status (mention the bot)
 * - Send a DM
 * - Poll notifications for bot replies
 * - Vote on a poll
 * - Get account info
 */

export interface MastodonAccount {
  id: string;
  username: string;
  acct: string;
  access_token: string;
}

export interface MastodonStatus {
  created_at: string;
  id: string;
  content: string;
  visibility: string;
  in_reply_to_id: string | null;
  poll?: MastodonPoll | null;
  account: { id: string; username: string; acct: string };
  mentions: { id: string; username: string; acct: string }[];
}

export interface MastodonPoll {
  id: string;
  expires_at: string | null;
  expired: boolean;
  options: { title: string; votes_count: number }[];
}

export interface MastodonConversation {
  id: string;
  unread: boolean;
  accounts: { id: string; username: string; acct: string }[];
  last_status: MastodonStatus | null;
}

export interface MastodonNotification {
  id: string;
  type: "mention" | "poll" | "follow" | "follow_request" | "favourite" | "reblog" | "status";
  created_at: string;
  account: { id: string; username: string; acct: string };
  status?: MastodonStatus;
}

class MastodonAPI {
  private baseUrl: string;
  private token: string;
  private debug: boolean;

  constructor(baseUrl: string, token: string, debug = false) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.debug = debug;
  }

  /**
   * This account's instance, e.g. "ursal.zone".
   *
   * Needed to resolve unqualified `acct` values: Mastodon omits the instance
   * for LOCAL accounts, so a bare acct only means something relative to the
   * instance doing the looking.
   */
  get instance(): string {
    return this.baseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
    if (this.debug) console.log(`  → ${method} ${path}`);

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Mastodon API ${res.status}: ${text.slice(0, 200)}`);
    }

    // 204 No Content
    if (res.status === 204) return null;
    return res.json();
  }

  /** Get the authenticated account's info. */
  async getMe(): Promise<MastodonAccount> {
    return this.request("GET", "/accounts/verify_credentials");
  }

  /** Post a public status. Returns the created status. */
  async postStatus(content: string, opts: { visibility?: string; in_reply_to_id?: string } = {}): Promise<MastodonStatus> {
    return this.request("POST", "/statuses", {
      status: content,
      visibility: opts.visibility || "public",
      in_reply_to_id: opts.in_reply_to_id || undefined,
    });
  }

  /** Send a DM (direct message) to another account. */
  async sendDM(accountId: string, content: string): Promise<MastodonStatus> {
    return this.request("POST", "/statuses", {
      status: content,
      visibility: "direct",
      // DMs in Mastodon require mentioning the recipient
    });
  }

  /** Send a DM by mentioning the bot handle (for the bot's DM flow). */
  async sendBotDM(botAcct: string, content: string): Promise<MastodonStatus> {
    // The bot expects DMs that mention it, so we send a direct visibility post mentioning the bot
    return this.request("POST", "/statuses", {
      status: `@${botAcct} ${content}`,
      visibility: "direct",
    });
  }

  /** Get the latest N notifications. */
  async getNotifications(limit = 20): Promise<MastodonNotification[]> {
    return this.request("GET", `/notifications?limit=${limit}`);
  }

  /**
   * Get recent direct-message conversations.
   *
   * Cross-instance DMs (mastodon.social -> ursal.zone) do NOT generate
   * mention notifications on the receiving side, but they DO appear here.
   * This is the reliable signal for the bot's replies to a player.
   */
  async getConversations(limit = 20): Promise<MastodonConversation[]> {
    return this.request("GET", `/conversations?limit=${limit}`);
  }

  /** Clear all notifications (so we can detect new ones). */
  async clearNotifications(): Promise<void> {
    await this.request("POST", "/notifications/clear");
  }

  /** Get a specific status by ID. */
  async getStatus(id: string): Promise<MastodonStatus> {
    return this.request("GET", `/statuses/${id}`);
  }

  /** Get the reply/thread tree around a status. */
  async getStatusContext(
    id: string,
  ): Promise<{ ancestors: MastodonStatus[]; descendants: MastodonStatus[] }> {
    return this.request("GET", `/statuses/${id}/context`);
  }

  /** Vote on a poll. optionIndices is 0-based. */
  async votePoll(statusId: string, pollId: string, choices: number[]): Promise<MastodonPoll> {
    return this.request("POST", `/polls/${pollId}/vote`, { choices });
  }

  /** Look up an account by username. */
  async lookupAccount(username: string): Promise<MastodonAccount> {
    return this.request("GET", `/accounts/lookup?acct=${encodeURIComponent(username)}`);
  }
}

export { MastodonAPI };

/** Wait for the bot to post a poll status. Checks bot's own account statuses. */
export async function waitForBotPoll(
  botApi: MastodonAPI,
  since: string,
  timeoutSec: number,
  pollIntervalMs = 5000,
  debug = false,
): Promise<MastodonStatus | null> {
  const deadline = Date.now() + timeoutSec * 1000;
  const me = await botApi.getMe();

  while (Date.now() < deadline) {
    try {
      const recent: MastodonStatus[] = await botApi.request("GET", `/accounts/${me.id}/statuses?limit=10`);
      for (const s of recent) {
        if (new Date(s.created_at) > new Date(since) && s.poll) {
          if (debug) console.log(`  ✓ Bot posted poll: ${s.id}`);
          return s;
        }
      }
    } catch {
      // Ignore transient errors
    }
    await sleep(pollIntervalMs);
  }
  if (debug) console.log(`  ✗ Timed out waiting for bot poll`);
  return null;
}

/** Wait for the bot to post a finale status (non-reply with 🏆 or encerrad). */
export async function waitForBotFinale(
  botApi: MastodonAPI,
  since: string,
  timeoutSec: number,
  pollIntervalMs = 10000,
  debug = false,
): Promise<MastodonStatus | null> {
  const deadline = Date.now() + timeoutSec * 1000;
  const me = await botApi.getMe();

  while (Date.now() < deadline) {
    try {
      const recent: MastodonStatus[] = await botApi.request("GET", `/accounts/${me.id}/statuses?limit=10`);
      for (const s of recent) {
        if (new Date(s.created_at) > new Date(since) && !s.in_reply_to_id &&
            (s.content.includes("🏆") || s.content.includes("winner") || s.content.includes("encerrad"))) {
          if (debug) console.log(`  ✓ Bot posted finale: ${s.id}`);
          return s;
        }
      }
    } catch {
      // Ignore transient errors
    }
    await sleep(pollIntervalMs);
  }
  if (debug) console.log(`  ✗ Timed out waiting for bot finale`);
  return null;
}


/**
 * Wait for a notification matching a predicate.
 * Returns the first matching notification, or null on timeout.
 */
export async function waitForNotification(
  api: MastodonAPI,
  predicate: (n: MastodonNotification) => boolean,
  timeoutSec: number,
  pollIntervalMs = 3000,
  debug = false,
): Promise<MastodonNotification | null> {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastSeenId: string | null = null;

  while (Date.now() < deadline) {
    const notifs = await api.getNotifications(10);
    // Look for new notifications (newer than lastSeenId) matching predicate
    for (const n of notifs) {
      if (lastSeenId && n.id <= lastSeenId) continue;
      if (predicate(n)) {
        if (debug) console.log(`  ✓ Found matching notification: ${n.type} from ${n.account.acct}`);
        return n;
      }
    }
    if (notifs.length > 0) {
      lastSeenId = notifs[0].id;
    }
    await sleep(pollIntervalMs);
  }
  if (debug) console.log(`  ✗ Timed out waiting for notification`);
  return null;
}

/**
 * Wait for a reply from the bot to a specific status.
 */
export async function waitForBotReply(
  api: MastodonAPI,
  botAcct: string,
  inReplyToId: string,
  timeoutSec: number,
  debug = false,
): Promise<MastodonStatus | null> {
  const deadline = Date.now() + timeoutSec * 1000;
  const norm = (s: string) => s.replace(/^@/, "").toLowerCase();

  while (Date.now() < deadline) {
    // 1) Direct mention notification (works when the bot replies inline).
    const notifs = await api.getNotifications(10);
    for (const n of notifs) {
      if (n.type === "mention" && norm(n.account.acct) === norm(botAcct) && n.status?.in_reply_to_id === inReplyToId) {
        if (debug) console.log(`  ✓ Bot replied to status ${inReplyToId} (notification)`);
        return n.status;
      }
    }

    // 2) Thread context: the bot opens a NEW thread rooted at its own status,
    //    so the host gets no mention notification for it. Poll the context of
    //    the status the host posted and accept the bot's thread root.
    try {
      const ctx = await api.getStatusContext(inReplyToId);
      // The bot's creation status is a thread ROOT, so it is an ancestor of
      // the host's post. Check both directions to be safe.
      const nearby = [...ctx.descendants, ...ctx.ancestors];
      for (const s of nearby) {
        if (norm(s.account.acct) === norm(botAcct)) {
          if (debug) console.log(`  ✓ Bot status ${s.id} found via context`);
          return s;
        }
      }
    } catch {
      // context unavailable (deleted/private) — keep polling
    }

    await sleep(3000);
  }
  if (debug) console.log(`  ✗ Timed out waiting for bot reply to ${inReplyToId}`);
  return null;
}

/**
 * Wait for the bot to post a new status (not a reply) — e.g. a poll.
 * Returns the first new bot status after `since` timestamp.
 */
export async function waitForBotPost(
  botApi: MastodonAPI,
  since: string,
  timeoutSec: number,
  debug = false,
): Promise<MastodonStatus | null> {
  const deadline = Date.now() + timeoutSec * 1000;
  const me = await botApi.getMe();

  while (Date.now() < deadline) {
    try {
      const recent: MastodonStatus[] = await botApi.request("GET", `/accounts/${me.id}/statuses?limit=5`);
      for (const s of recent) {
        if (new Date(s.created_at) > new Date(since) && !s.in_reply_to_id) {
          if (debug) console.log(`  ✓ Bot posted new status: ${s.id}`);
          return s;
        }
      }
    } catch {
      // Ignore transient errors
    }
    await sleep(5000);
  }
  if (debug) console.log(`  ✗ Timed out waiting for new bot post`);
  return null;
}

/**
 * Wait for a specific amount of time (for poll expiry etc.)
 */
export function waitFor(seconds: number, label: string): Promise<void> {
  console.log(`  ⏳ Waiting ${seconds}s for ${label}...`);
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * Sleep for N milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Does a reported `acct` refer to the target handle?
 *
 * Mastodon reports LOCAL accounts unqualified ("saiugol") and REMOTE ones
 * fully qualified ("user@host"). A bare acct therefore means "a user on the
 * viewer's instance", not any user with that name - so the instance must be
 * checked before the username. Comparing the local part alone is wrong: the
 * bot is mauriciobc@mastodon.social and the player is mauriciobc@ursal.zone,
 * so the player's own outgoing statuses would look like the bot's.
 *
 * Note: account IDs are NOT a safe substitute, because a remote account has
 * a different ID on each viewing instance (the bot is 1474 on ursal.zone and
 * 588005 on mastodon.social).
 */
export function acctMatches(
  reportedAcct: string,
  viewerInstance: string,
  targetHandle: string,
): boolean {
  return qualifyAcct(reportedAcct, viewerInstance) === qualifyAcct(targetHandle, viewerInstance);
}

/**
 * Expand a possibly-bare acct into a fully qualified "user@instance" handle.
 *
 * Mastodon omits the instance for accounts on the instance doing the looking,
 * so a bare "mauriciobc" seen from mastodon.social is mauriciobc@mastodon.social.
 * Comparing handles only works after both sides are qualified.
 */
function qualifyAcct(acct: string, viewerInstance: string): string {
  const clean = acct.replace(/^@/, "").toLowerCase();
  return clean.includes("@") ? clean : `${clean}@${viewerInstance.toLowerCase()}`;
}

/**
 * Wait for the bot to DM a player.
 *
 * Uses acctMatches so a same-instance bot (reported as a bare username) and
 * a cross-instance bot (reported as "user@host") are both handled, while the
 * player's own statuses are never mistaken for the bot's.
 *
 * Cross-instance DMs produce no mention notification on the receiving
 * instance, so GET /notifications finds nothing; GET /conversations does.
 */
export async function waitForBotDM(
  playerApi: MastodonAPI,
  botHandle: string,
  since: string,
  timeoutSec: number,
  debug = false,
): Promise<MastodonStatus | null> {
  const deadline = Date.now() + timeoutSec * 1000;

  while (Date.now() < deadline) {
    try {
      const convs = await playerApi.getConversations(20);
      for (const c of convs) {
        const s = c.last_status;
        if (!s) continue;
        if (new Date(s.created_at) < new Date(since)) continue;
        if (!acctMatches(s.account.acct, playerApi.instance, botHandle)) continue;
        if (debug) console.log(`  ✓ Bot DM ${s.id} via conversation (@${s.account.acct})`);
        return s;
      }
    } catch {
      // transient API error — keep polling
    }
    await sleep(3000);
  }
  if (debug) console.log(`  ✗ Timed out waiting for bot DM (${botHandle})`);
  return null;
}
