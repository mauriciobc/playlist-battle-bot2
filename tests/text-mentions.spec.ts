import { describe, it, expect } from "vitest";
import type { MockMastodonServer } from "../test/integration/mock-mastodon.js";
import { AUTH, postJson, startMock, type Json } from "../test/integration/mock-kit.js";

/**
 * The last missing link in the chain.
 *
 * The driver posts the newgame as plain text with the handle embedded:
 *
 *   `@${botHandle} newgame "theme" 2 @${playerHandle}`
 *
 * On real Mastodon that @handle in the text is what creates the mention
 * notification - Notifier/Status#parse_mentions scans the rendered content,
 * not a separate mentions parameter. The docs' streaming example shows the
 * resulting notification: type "mention", account = the mentioning account.
 *
 * The mock only honoured an explicit `mentions` array, which no client sends,
 * so a driver-posted newgame produced a status nobody was notified about and
 * every run died waiting for a reply.
 *
 * So the mock must resolve @handle from the status text.
 */

const hostPost = (server: MockMastodonServer, text: string) =>
  postJson(server, "/api/v1/statuses", { status: text }, "host-token");

const notifications = async (server: MockMastodonServer, auth = AUTH) =>
  ((await (
    await fetch(`${server.baseUrl}/api/v1/notifications?limit=10`, { headers: auth })
  ).json()) as Json[]);

describe("mentions parsed from the status text", () => {
  it("notifies an @handle written in the text, as the driver posts it", async () => {
    const server = await startMock();
    await hostPost(server, '@bot newgame "integration" 2 @player');
    const n = await notifications(server);
    expect(n.length).toBe(1);
    expect(n[0]?.type).toBe("mention");
    expect((n[0]?.account as Json).acct).toBe("host@mock.social");
    await server.stop();
  });

  it("notifies every handle in the text, not only the first", async () => {
    const server = await startMock();
    await hostPost(server, "@bot newgame @player duel");
    // The bot's own queue has one; the player has theirs in their own.
    expect((await notifications(server)).length).toBe(1);
    const playerQueue = await notifications(server, { Authorization: "Bearer player-token" });
    expect(playerQueue.length).toBe(1);
    await server.stop();
  });

  it("resolves a fully-qualified @handle@host", async () => {
    const server = await startMock();
    await hostPost(server, "@bot@mock.social hello");
    expect((await notifications(server)).length).toBe(1);
    await server.stop();
  });

  it("ignores an unknown handle rather than failing the status", async () => {
    const server = await startMock();
    const res = await hostPost(server, "@nobody@elsewhere.example hello");
    expect(res.status).toBe(200);
    expect((await notifications(server)).length).toBe(0);
    await server.stop();
  });

  it("ignores a bare @ word that is not a handle", async () => {
    const server = await startMock();
    await hostPost(server, "email me @ home if you like");
    expect((await notifications(server)).length).toBe(0);
    await server.stop();
  });

  it("does not notify the author about their own status", async () => {
    const server = await startMock();
    // The bot posts a status mentioning the player; the bot's own queue
    // must stay empty.
    await postJson(server, "/api/v1/statuses", { status: "@player your move" });
    expect((await notifications(server)).length).toBe(0);
    await server.stop();
  });
});
