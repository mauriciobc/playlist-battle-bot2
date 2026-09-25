import { describe, it, expect, beforeEach } from "vitest";
import type { MockMastodonServer } from "../test/integration/mock-mastodon.js";
import { AUTH, jsonOf, post, startMock, type Json } from "../test/integration/mock-kit.js";

/**
 * The mock originally implemented six routes, but the driver needs two more:
 * it reads a status's thread and an account's statuses to decide whether the
 * bot replied. Missing them turned into a 404 that surfaced as
 * "create — never happened", which is a misleading way to learn the server is
 * incomplete.
 *
 *   REST::ContextSerializer  - has_many :ancestors, has_many :descendants
 *   AccountsController#statuses - a plain array of REST::StatusSerializer
 */

describe("MockMastodon: status context", () => {
  let server: MockMastodonServer;
  beforeEach(async () => {
    server = await startMock();
  });

  it("returns ancestors and descendants arrays", async () => {
    const root = await post(server, { status: "root" });
    const res = await fetch(`${server.baseUrl}/api/v1/statuses/${root.id}/context`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    // REST::ContextSerializer declares exactly these two.
    expect(Array.isArray(body.ancestors)).toBe(true);
    expect(Array.isArray(body.descendants)).toBe(true);
    expect(body.ancestors).toEqual([]);
    expect(body.descendants).toEqual([]);
  });

  it("places the parent in ancestors and the reply in descendants", async () => {
    const parent = await post(server, { status: "newgame" });
    const reply = await post(server, {
      status: "reply",
      in_reply_to_id: parent.id,
    });
    const parentCtx = await jsonOf(
      await fetch(`${server.baseUrl}/api/v1/statuses/${parent.id}/context`, {
        headers: AUTH,
      }),
    );
    expect((parentCtx.descendants as Json[]).map((s) => s.id)).toEqual([reply.id]);

    const replyCtx = await jsonOf(
      await fetch(`${server.baseUrl}/api/v1/statuses/${reply.id}/context`, {
        headers: AUTH,
      }),
    );
    expect((replyCtx.ancestors as Json[]).map((s) => s.id)).toEqual([parent.id]);
  });

  it("404s an unknown status", async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/statuses/nope/context`, {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });
});

describe("MockMastodon: account statuses", () => {
  let server: MockMastodonServer;
  beforeEach(async () => {
    server = await startMock();
  });

  it("returns an array of that account's statuses, newest first", async () => {
    await post(server, { status: "one" });
    await post(server, { status: "two" });
    const me = await jsonOf(
      await fetch(`${server.baseUrl}/api/v1/accounts/verify_credentials`, {
        headers: AUTH,
      }),
    );
    const res = await fetch(
      `${server.baseUrl}/api/v1/accounts/${me.id}/statuses?limit=40`,
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Json[];
    expect(body).toHaveLength(2);
    expect(body[0]?.content).toContain("two");
  });

  it("404s an unknown account", async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/accounts/999999/statuses`, {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });
});
