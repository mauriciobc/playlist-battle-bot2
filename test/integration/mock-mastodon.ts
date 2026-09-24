/**
 * A small HTTP server implementing the six Mastodon routes the bot actually
 * calls. The point is to exercise the real bot code - state machine, tune
 * collision, poll creation, vote - without depending on a live instance's
 * status-posting throttle, which is what blocked the live runs.
 *
 * It is deliberately NOT a Mastodon reimplementation: no federation, no
 * timelines, no media, no moderation. The response shapes are transcribed
 * from https://github.com/mastodon/mastodon; see mock-mastodon-state.ts for
 * the per-field citations and tests/mock-mastodon.spec.ts for the contract.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  MockState,
  type MockAccount,
  type MockPoll,
  type MockStatus,
  type SeedNotification,
} from "./mock-mastodon-state.js";

export type MockMastodonOptions = {
  botAcct: string;
  hostAcct: string;
  playerAcct: string;
  /** Any string; the mock treats it as the bot's bearer token. */
  token?: string;
  port?: number;
};

type Json = Record<string, unknown>;

export class MockMastodonServer {
  readonly state: MockState;
  readonly token: string;
  baseUrl = "";
  private port = 0;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(opts: MockMastodonOptions) {
    this.token = opts.token ?? "mock-token";
    this.port = opts.port ?? 0;
    this.state = new MockState({
      botAcct: opts.botAcct,
      hostAcct: opts.hostAcct,
      playerAcct: opts.playerAcct,
    });
    this.state.registerToken(this.token, opts.botAcct);
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    this.port = typeof address === "object" && address ? address.port : this.port;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Test hooks - not part of the Mastodon API surface. */

  pushNotification(seed: SeedNotification): string {
    const state = this.state;
    const account = state.addAccount(seed.fromAcct);
    const id = state.nextId();
    state.notifications.push({
      id,
      type: seed.type,
      accountId: account.id,
      statusId: seed.statusId ?? null,
      createdAt: new Date().toISOString(),
      groupKey: `ungrouped-${id}`,
    });
    return id;
  }

  /** Force a poll past its expiry, the way waiting 300s otherwise would. */
  expirePoll(pollId: string): void {
    const poll = state_get(this.state.polls, pollId);
    if (!poll) return;
    poll.expiresAt = Math.floor(Date.now() / 1000) - 1;
  }

  // ── HTTP ───────────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = new URL(req.url ?? "/", this.baseUrl || "http://localhost");
      const viewer = this.state.accountForToken(bearer(req));
      if (!viewer) return json(res, 401, { error: "The access token is invalid" });

      const method = req.method ?? "GET";
      const p = path.pathname;

      // GET /api/v1/accounts/verify_credentials
      if (method === "GET" && p === "/api/v1/accounts/verify_credentials") {
        return json(res, 200, this.state.serializeAccount(viewer));
      }

      // GET /api/v1/accounts/lookup
      if (method === "GET" && p === "/api/v1/accounts/lookup") {
        const found = this.state.lookup(path.searchParams.get("acct") ?? "");
        if (!found) return json(res, 404, { error: "Record not found" });
        return json(res, 200, this.state.serializeAccount(found));
      }

      // GET /api/v1/notifications
      if (method === "GET" && p === "/api/v1/notifications") {
        return this.notifications(res, path, viewer);
      }

      // POST /api/v1/statuses
      if (method === "POST" && p === "/api/v1/statuses") {
        return this.createStatus(res, await body(req), viewer);
      }

      // GET|DELETE /api/v1/statuses/:id
      const statusMatch = p.match(/^\/api\/v1\/statuses\/([^/]+)$/);
      const statusId = statusMatch?.[1];
      if (statusId !== undefined) {
        if (method === "DELETE") {
          const removed = this.state.statuses.get(statusId);
          if (!removed) return json(res, 404, { error: "Record not found" });
          this.state.statuses.delete(removed.id);
          const serialized = this.state.serializeStatus(removed.id, viewer);
          return json(res, 200, serialized);
        }
        if (method === "GET") {
          const serialized = this.state.serializeStatus(statusId, viewer);
          if (!serialized) return json(res, 404, { error: "Record not found" });
          return json(res, 200, serialized);
        }
      }

      // POST /api/v1/polls/:id/votes
      const voteMatch = p.match(/^\/api\/v1\/polls\/([^/]+)\/votes$/);
      const votePollId = voteMatch?.[1];
      if (method === "POST" && votePollId !== undefined) {
        return this.vote(res, votePollId, await body(req), viewer);
      }

      // GET /api/v1/polls/:id
      const pollMatch = p.match(/^\/api\/v1\/polls\/([^/]+)$/);
      const pollId = pollMatch?.[1];
      if (method === "GET" && pollId !== undefined) {
        const serialized = this.state.serializePoll(pollId, viewer);
        if (!serialized) return json(res, 404, { error: "Record not found" });
        return json(res, 200, serialized);
      }

      return json(res, 404, { error: "Record not found" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : "internal error" });
    }
  }

  /**
   * Notifications are newest-first, as Mastodon's NotificationsController
   * orders them. `since_id` and `max_id` are exclusive bounds, `limit` caps
   * the page, and a further page is advertised with a `Link` header
   * (`rel="next"`), which is what the bot's getWithLink() follows.
   */
  private notifications(
    res: ServerResponse,
    path: URL,
    viewer: MockAccount,
  ): void {
    const excluded = new Set(path.searchParams.getAll("exclude_types[]"));
    const sinceId = path.searchParams.get("since_id");
    const maxId = path.searchParams.get("max_id");
    const limit = Number(path.searchParams.get("limit") ?? 40) || 40;

    let items = [...this.state.notifications].reverse(); // newest first
    if (sinceId) items = items.filter((n) => Number(n.id) > Number(sinceId));
    if (maxId) items = items.filter((n) => Number(n.id) < Number(maxId));
    if (excluded.size > 0) items = items.filter((n) => !excluded.has(n.type));

    const page = items.slice(0, limit);
    const rest = items.slice(limit);
    const oldestOnPage = page[page.length - 1];
    if (rest.length > 0 && oldestOnPage !== undefined) {
      const nextMax = oldestOnPage.id;
      const query = new URLSearchParams(path.searchParams);
      query.delete("max_id");
      query.set("max_id", nextMax);
      res.setHeader(
        "Link",
        `<${this.baseUrl}/api/v1/notifications?${query.toString()}>; rel="next"`,
      );
    }
    json(res, 200, page.map((n) => this.state.serializeNotification(n, viewer)));
  }

  private createStatus(res: ServerResponse, input: Json, viewer: MockAccount): void {
    const content = typeof input.status === "string" ? input.status : "";
    if (content.trim().length === 0) {
      return json(res, 422, { error: "Text can't be blank" });
    }
    const inReplyToId =
      typeof input.in_reply_to_id === "string" ? input.in_reply_to_id : null;

    const pollInput = (input.poll ?? null) as Json | null;
    let poll: MockPoll | null = null;
    if (pollInput !== null && typeof pollInput === "object") {
      const problem = this.state.validatePoll(pollInput);
      if (problem) return json(res, 422, { error: problem });
    }

    const status: MockStatus = {
      id: this.state.nextId(),
      accountId: viewer.id,
      content,
      inReplyToId,
      createdAt: new Date().toISOString(),
      pollId: null,
    };
    this.state.statuses.set(status.id, status);

    if (pollInput !== null && typeof pollInput === "object") {
      const raw = Array.isArray(pollInput.options) ? pollInput.options : [];
      const options = raw.map((o) => String(o).trim()).filter((o) => o.length > 0);
      const created: MockPoll = {
        id: this.state.nextId(),
        accountId: viewer.id,
        statusId: status.id,
        options,
        expiresAt: Math.floor(Date.now() / 1000) + Number(pollInput.expires_in),
        multiple: pollInput.multiple === true,
        hideTotals: pollInput.hide_totals === true,
        votes: new Map(),
      };
      this.state.polls.set(created.id, created);
      status.pollId = created.id;
    }

    json(res, 200, this.state.serializeStatus(status.id, viewer));
  }

  /**
   * Api::V1::Polls::VotesController#create. `params.require(:choices)` raises
   * ParameterMissing (400) when choices is absent - note the plural, and
   * that a singular `choice` is a hard error rather than a tolerated alias.
   * VoteService then rejects an expired poll or an out-of-range choice.
   */
  private vote(res: ServerResponse, pollId: string, input: Json, viewer: MockAccount): void {
    if (!("choices" in input) || input.choices === null) {
      return json(res, 400, { error: "param is missing or the value is empty: choices" });
    }
    if (!Array.isArray(input.choices)) {
      return json(res, 400, { error: "param is missing or the value is empty: choices" });
    }
    const poll = this.state.polls.get(pollId);
    if (!poll) return json(res, 404, { error: "Record not found" });
    if (this.state.pollExpired(poll)) {
      return json(res, 422, { error: "The poll has already ended" });
    }
    const choices = input.choices.map((c) => Number(c));
    if (choices.some((c) => !Number.isInteger(c) || c < 0 || c >= poll.options.length)) {
      return json(res, 422, { error: "Invalid choice" });
    }
    if (!poll.multiple && new Set(choices).size !== choices.length) {
      return json(res, 422, { error: "Duplicate choices" });
    }
    // A re-vote replaces the previous ballot, as PollVote does upstream.
    poll.votes.set(viewer.id, choices);
    json(res, 200, this.state.serializePoll(pollId, viewer));
  }
}

function state_get<T>(map: Map<string, T>, key: string): T | undefined {
  return map.get(key);
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? null;
}

async function body(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Json) : {};
  } catch {
    return {};
  }
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

export { MockState };
export type { SeedNotification };
