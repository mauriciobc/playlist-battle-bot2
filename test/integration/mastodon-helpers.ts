/**
 * Thin Mastodon API helpers for the integration driver.
 *
 * Uses raw fetch — no external deps needed. Supports:
 * - Post a status (mention the bot)
 * - Send a DM to the bot
 * - Read conversations, thread context and an account's statuses
 * - Vote on a poll
 * - Get account info
 */

interface MastodonAccount {
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
  /** Whether multiple choices are allowed. */
  multiple: boolean;
  /** Total votes cast, counted with multiplicity. */
  votes_count: number;
  /** Distinct accounts that have voted. */
  voters_count: number;
  /**
   * Whether the requesting account has voted. OMITTED when the request is
   * unauthenticated - REST::PollSerializer emits it `if: :current_user?`.
   */
  voted?: boolean;
  /** The requesting account's own choices. Same unauthenticated caveat. */
  own_votes?: number[];
  options: { title: string; votes_count: number }[];
}

interface MastodonConversation {
  id: string;
  unread: boolean;
  accounts: { id: string; username: string; acct: string }[];
  last_status: MastodonStatus | null;
}

/**
 * Resolve the API origin for a role.
 *
 * The driver used to build `https://${hostInstance}` unconditionally, so
 * aiming it at the mock Mastodon would have sent it to https://mock.social -
 * a real DNS lookup rather than the mock listening on 127.0.0.1. An explicit
 * override wins when given; a bare host still gets https, so the live runs
 * use the same code path as the mock runs.
 */
export function resolveBaseUrl(
  override: string | undefined,
  host: string | undefined,
): string {
  const fallback = (host ?? "").trim() || "mastodon.social";
  const explicit = (override ?? "").trim();
  if (explicit.length > 0) return explicit.replace(/\/+$/, "");
  return `https://${fallback}`;
}

export class MastodonAPI {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly debug = false,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
    if (this.debug) console.log(`  → ${method} ${path}`);

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Mastodon API ${res.status}: ${text.slice(0, 200)}`);
    }

    // 204 No Content
    return (res.status === 204 ? null : await res.json()) as T;
  }

  /** Get the authenticated account's info. */
  async getMe(): Promise<MastodonAccount> {
    return this.request("GET", "/accounts/verify_credentials");
  }

  /** Post a public status. Returns the created status. */
  async postStatus(content: string): Promise<MastodonStatus> {
    return this.request("POST", "/statuses", { status: content, visibility: "public" });
  }

  /** Send a DM by mentioning the bot handle (for the bot's DM flow). */
  async sendBotDM(botAcct: string, content: string): Promise<MastodonStatus> {
    // The bot expects DMs that mention it, so we send a direct visibility post mentioning the bot
    return this.request("POST", "/statuses", {
      status: `@${botAcct} ${content}`,
      visibility: "direct",
    });
  }

  /**
   * Get recent direct-message conversations.
   *
   * Cross-instance DMs (mastodon.social -> ursal.zone) do NOT generate
   * mention notifications on the receiving side, but they DO appear here.
   * This is the reliable signal for the bot's replies to a player.
   *
   * Observed in live runs, the other way round for a SAME-instance DM (bot
   * to host on mastodon.social): absent from /conversations and
   * /notifications, fetchable only by GET /statuses/:id. The driver therefore
   * never waits on the host's acknowledgements.
   */
  async getConversations(limit = 20): Promise<MastodonConversation[]> {
    return this.request("GET", `/conversations?limit=${limit}`);
  }

  /** Get the reply/thread tree around a status. */
  async getStatusContext(
    id: string,
  ): Promise<{ ancestors: MastodonStatus[]; descendants: MastodonStatus[] }> {
    return this.request("GET", `/statuses/${id}/context`);
  }

  /** Vote on a poll. optionIndices is 0-based. */
  async votePoll(statusId: string, pollId: string, choices: number[]): Promise<MastodonPoll> {
    // Route is /polls/:id/votes (plural) - see config/routes/api.rb:
    //   resources :polls, only: [:show] do
    //     resources :votes, only: :create, module: :polls
    //   end
    return this.request("POST", `/polls/${pollId}/votes`, { choices });
  }

  /** Look up an account by handle, returning its id. */
  async resolveAccountId(handle: string): Promise<string> {
    const acct = await this.lookupAccount(handle);
    return acct.id;
  }

  /**
   * Public/unlisted statuses of an account, newest first.
   *
   * The harness holds no bot token, so it reads the bot's timeline through
   * whichever player API can see it. Polls and finales are posted publicly,
   * so this is where they are observable.
   */
  async getAccountStatusesByHandle(handle: string, limit = 20): Promise<MastodonStatus[]> {
    const acct = await this.lookupAccount(handle);
    return this.request("GET", `/accounts/${acct.id}/statuses?limit=${limit}`);
  }

  /** Look up an account by username. */
  private async lookupAccount(username: string): Promise<MastodonAccount> {
    return this.request("GET", `/accounts/lookup?acct=${encodeURIComponent(username)}`);
  }
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
