/**
 * State, serializers and validators for the mock Mastodon server.
 *
 * Every constant and every field below is transcribed from the real
 * implementation in https://github.com/mastodon/mastodon so the mock cannot
 * drift into proving something the bot would never see in production:
 *
 *   app/validators/poll_expiration_validator.rb  MIN/MAX_EXPIRATION
 *   app/validators/poll_options_validator.rb     MAX_OPTIONS, MAX_OPTION_CHARS
 *   app/serializers/rest/poll_serializer.rb      poll + option attributes
 *   app/serializers/rest/status_serializer.rb    status attributes, :poll
 *   app/serializers/rest/notification_serializer.rb  notification attributes
 *   app/serializers/rest/account_serializer.rb   account attributes
 *   app/controllers/api/v1/polls/votes_controller.rb  params.require(:choices)
 *   app/models/poll.rb                           show_totals_now?, voted?, own_votes
 */

export const MIN_EXPIRATION_SEC = 300; // MIN_EXPIRATION = 5.minutes
export const MAX_EXPIRATION_SEC = 2_592_000; // MAX_EXPIRATION = 1.month
export const MAX_OPTIONS = 4; // PollOptionsValidator::MAX_OPTIONS
export const MAX_OPTION_CHARS = 50; // PollOptionsValidator::MAX_OPTION_CHARS

export type MockAccount = {
  id: string;
  username: string;
  acct: string;
  domain: string | null; // null when local to the mock server
};

export type MockPoll = {
  id: string;
  accountId: string;
  statusId: string;
  options: string[];
  expiresAt: number; // epoch seconds
  multiple: boolean;
  hideTotals: boolean;
  votes: Map<string, number[]>; // accountId -> chosen option indexes
};

export type MockStatus = {
  id: string;
  accountId: string;
  content: string;
  inReplyToId: string | null;
  createdAt: string;
  pollId: string | null;
};

export type MockNotification = {
  id: string;
  type: string;
  accountId: string;
  statusId: string | null;
  createdAt: string;
  groupKey: string;
};

export type SeedNotification = {
  type: string;
  fromAcct: string;
  statusId?: string;
};

export function splitAcct(acct: string): { username: string; domain: string | null } {
  const at = acct.lastIndexOf("@");
  if (at < 0) return { username: acct, domain: null };
  return { username: acct.slice(0, at), domain: acct.slice(at + 1) };
}

/** NotificationSerializer#status_type? - these carry a serialized status. */
const STATUS_TYPES = new Set([
  "favourite",
  "reblog",
  "status",
  "mention",
  "poll",
  "update",
  "quoted_update",
  "quote",
]);

export class MockState {
  readonly accounts = new Map<string, MockAccount>();
  readonly byAcct = new Map<string, string>();
  /** token -> accountId */
  readonly tokens = new Map<string, string>();
  readonly statuses = new Map<string, MockStatus>();
  readonly polls = new Map<string, MockPoll>();
  readonly notifications: MockNotification[] = [];

  private seq = 1000;
  readonly domain: string;

  constructor(opts: { botAcct: string; hostAcct: string; playerAcct: string }) {
    this.domain = splitAcct(opts.botAcct).domain ?? "mock.local";
    this.addAccount(opts.botAcct);
    this.addAccount(opts.hostAcct);
    this.addAccount(opts.playerAcct);
  }

  nextId(): string {
    this.seq += 1;
    return String(this.seq);
  }

  addAccount(acct: string): MockAccount {
    const existing = this.byAcct.get(acct);
    if (existing) return this.accounts.get(existing)!;
    const { username, domain } = splitAcct(acct);
    const account: MockAccount = {
      id: this.nextId(),
      username,
      acct,
      domain: domain === this.domain ? null : domain,
    };
    this.accounts.set(account.id, account);
    this.byAcct.set(acct, account.id);
    return account;
  }

  registerToken(token: string, acct: string): void {
    const account = this.addAccount(acct);
    this.tokens.set(token, account.id);
  }

  accountForToken(token: string | null): MockAccount | null {
    if (!token) return null;
    const id = this.tokens.get(token);
    return id ? (this.accounts.get(id) ?? null) : null;
  }

  /**
   * Api::V1::AccountsController#lookup. A bare username resolves against the
   * local domain only; a qualified handle resolves by exact acct. This is why
   * the bot's qualifyAcct() must qualify a bare handle before asking.
   */
  lookup(rawAcct: string): MockAccount | null {
    const wanted = rawAcct.startsWith("@") ? rawAcct.slice(1) : rawAcct;
    const exact = this.byAcct.get(wanted);
    if (exact) return this.accounts.get(exact)!;
    const { username, domain } = splitAcct(wanted);
    if (domain !== null) return null; // qualified to a host we do not know
    for (const account of this.accounts.values()) {
      if (account.domain === null && account.username === username) return account;
    }
    return null;
  }

  // ── serializers ────────────────────────────────────────────────────────

  /** REST::AccountSerializer - id, username, acct are always present. */
  serializeAccount(account: MockAccount): Record<string, unknown> {
    return {
      id: account.id,
      username: account.username,
      acct: account.acct,
      display_name: account.username,
      locked: false,
      bot: true,
      discoverable: false,
      group: false,
      created_at: new Date(0).toISOString(),
      note: "",
      url: `https://${account.domain ?? this.domain}/@${account.username}`,
      uri: `https://${account.domain ?? this.domain}/@${account.username}`,
      followers_count: 0,
      following_count: 0,
      statuses_count: 0,
      hide_collections: false,
      noindex: false,
    };
  }

  /**
   * REST::StatusSerializer. `poll` is the has_one :preloadable_poll
   * association, so it is present only when the status carries one.
   */
  serializeStatus(id: string, viewer: MockAccount | null): Record<string, unknown> | null {
    const status = this.statuses.get(id);
    if (!status) return null;
    const account = this.accounts.get(status.accountId)!;
    return {
      id: status.id,
      created_at: status.createdAt,
      in_reply_to_id: status.inReplyToId,
      in_reply_to_account_id: null,
      sensitive: false,
      spoiler_text: "",
      visibility: "public",
      language: "pt",
      uri: `https://${this.domain}/@${account.username}/${status.id}`,
      url: `https://${this.domain}/@${account.username}/${status.id}`,
      replies_count: 0,
      reblogs_count: 0,
      favourites_count: 0,
      quotes_count: 0,
      edited_at: null,
      favourited: false,
      reblogged: false,
      muted: false,
      bookmarked: false,
      content: `<p>${status.content}</p>`,
      reblog: null,
      application: { name: "mock", website: null },
      account: this.serializeAccount(account),
      media_attachments: [],
      mentions: [],
      tags: [],
      emojis: [],
      card: null,
      poll:
        status.pollId === null
          ? null
          : this.serializePoll(status.pollId, viewer),
    };
  }

  /**
   * REST::PollSerializer. `voted` and `own_votes` are
   * `if: :current_user?`, so they appear only for an authenticated viewer.
   *
   * Poll#voted? is `account.id == account_id || votes.exists?` - the poll's
   * own author counts as having voted without a PollVote row.
   * Poll#show_totals_now? is `expired? || !hide_totals?`, which is where a
   * null votes_count comes from.
   */
  serializePoll(pollId: string, viewer: MockAccount | null): Record<string, unknown> | null {
    const poll = this.polls.get(pollId);
    if (!poll) return null;
    const expired = this.pollExpired(poll);
    const showTotals = expired || !poll.hideTotals;
    const tallies = new Array<number>(poll.options.length).fill(0);
    for (const choices of poll.votes.values()) {
      for (const choice of choices) {
        if (typeof tallies[choice] === "number") tallies[choice] += 1;
      }
    }
    const body: Record<string, unknown> = {
      id: poll.id,
      expires_at: new Date(poll.expiresAt * 1000).toISOString(),
      expired,
      multiple: poll.multiple,
      votes_count: tallies.reduce((a, b) => a + b, 0),
      voters_count: poll.votes.size,
      // OptionSerializer carries title and votes_count only - no id.
      options: poll.options.map((title, idx) => ({
        title,
        votes_count: showTotals ? tallies[idx] : null,
      })),
      emojis: [],
    };
    if (viewer) {
      const own = poll.votes.get(viewer.id) ?? [];
      body.voted = viewer.id === poll.accountId || own.length > 0;
      body.own_votes = own;
    }
    return body;
  }

  /**
   * REST::NotificationSerializer. id/type/created_at/group_key are
   * unconditional; `status` is `if: :status_type?`; `group_key` falls back to
   * "ungrouped-<id>".
   */
  serializeNotification(
    notification: MockNotification,
    viewer: MockAccount | null,
  ): Record<string, unknown> {
    const account = this.accounts.get(notification.accountId)!;
    const body: Record<string, unknown> = {
      id: notification.id,
      type: notification.type,
      created_at: notification.createdAt,
      group_key: notification.groupKey,
      account: this.serializeAccount(account),
    };
    const statusRef = notification.statusId ?? undefined;
    if (STATUS_TYPES.has(notification.type)) {
      const status =
        statusRef === undefined ? null : this.serializeStatus(statusRef, viewer);
      // An unknown status id still yields a shape, so the bot cannot crash on
      // a dangling reference the way a real tombstoned status would not.
      body.status =
        status ??
        {
          id: statusRef ?? "",
          created_at: notification.createdAt,
          content: "<p></p>",
          visibility: "public",
          account: this.serializeAccount(account),
          media_attachments: [],
          mentions: [],
          tags: [],
          emojis: [],
          poll: null,
        };
    }
    return body;
  }

  // ── poll behaviour ─────────────────────────────────────────────────────

  pollExpired(poll: MockPoll): boolean {
    return poll.expiresAt <= Math.floor(Date.now() / 1000);
  }

  /**
   * PollExpirationValidator + PollOptionsValidator. Returns an error message
   * or null. A short expiry is a 422 in the real API.
   */
  validatePoll(input: {
    options?: unknown;
    expires_in?: unknown;
    multiple?: unknown;
    hide_totals?: unknown;
  }): string | null {
    const raw = Array.isArray(input.options) ? input.options : [];
    const options = raw.map((o) => String(o).trim()).filter((o) => o.length > 0);
    if (options.length <= 1) return "Options is too short (minimum is 2)";
    if (options.length > MAX_OPTIONS) {
      return `Options is too long (maximum is ${MAX_OPTIONS})`;
    }
    for (const option of options) {
      if ([...option].length > MAX_OPTION_CHARS) {
        return `Options #{option} is over the maximum character limit (maximum is ${MAX_OPTION_CHARS} characters)`;
      }
    }
    if (new Set(options).size !== options.length) return "Options must be unique";

    // The API param is `expires_in` (snake_case), as StatusesController's
    // poll_params names it. Reading camelCase here silently produced
    // NaN and rejected every valid poll with 422.
    const expiresIn = Number(input.expires_in);
    if (!Number.isFinite(expiresIn)) return "Expires at can't be blank";
    if (Math.ceil(expiresIn) < MIN_EXPIRATION_SEC) {
      return "Expiration date can't be shorter than 5 minutes";
    }
    if (expiresIn > MAX_EXPIRATION_SEC) {
      return "Expiration date can't be longer than 1 month";
    }
    return null;
  }
}
