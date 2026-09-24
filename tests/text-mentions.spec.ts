import { describe, it, expect } from "vitest";
import { MockMastodonServer } from "../test/integration/mock-mastodon.js";

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

const BOT_AUTH = { Authorization: "Bearer mock-token" };
type Json = Record<string, unknown>;
const jsonOf = async (res: Response) => (await res.json()) as Json;

async function start() {
  const server = new MockMastodonServer({
    botAcct: "bot@mock.social",
    hostAcct: "host@mock.social",
    playerAcct: "player@mock.social",
  });
  server.registerToken("host-token", "host@mock.social");
  server.registerToken("player-token", "player@mock.social");
  await server.start();
  return server;
}

async function hostPost(server: MockMastodonServer, text: string): Promise<Response> {
  return fetch(`${server.baseUrl}/api/v1/statuses`, {
    method: "POST",
    headers: { Authorization: "Bearer host-token", "Content-Type": "application/json" },
    body: JSON.stringify({ status: text }),
  });
}

const notifications = async (server: MockMastodonServer, query = "") =>
  ((await (
    await fetch(`${server.baseUrl}/api/v1/notifications?limit=10${query}`, {
      headers: BOT_AUTH,
    })
  ).json()) as Json[]);

describe("mentions parsed from the status text", () => {
  it("notifies an @handle written in the text, as the driver posts it", async () => {
    const server = await start();
    await hostPost(server, '@bot newgame "integration" 2 @player');
    const n = await notifications(server);
    expect(n.length).toBe(1);
    expect(n[0]?.type).toBe("mention");
    expect((n[0]?.account as Json).acct).toBe("host@mock.social");
    await server.stop();
  });

  it("notifies every handle in the text, not only the first", async () => {
    const server = await start();
    await hostPost(server, "@bot newgame @player duel");
    // The bot's own queue has one; the player has theirs in their own.
    const botQueue = await notifications(server);
    expect(botQueue.length).toBe(1);
    // and the player's queue got the same status
    const playerQueue = ((await (
      await fetch(`${server.baseUrl}/api/v1/notifications?limit=10`, {
        headers: { Authorization: "Bearer player-token" },
      })
    ).json()) as Json[]);
    expect(playerQueue.length).toBe(1);
    await server.stop();
  });

  it("resolves a fully-qualified @handle@host", async () => {
    const server = await start();
    await hostPost(server, "@bot@mock.social hello");
    expect((await notifications(server)).length).toBe(1);
    await server.stop();
  });

  it("ignores an unknown handle rather than failing the status", async () => {
    const server = await start();
    const res = await hostPost(server, "@nobody@elsewhere.example hello");
    expect(res.status).toBe(200);
    expect((await notifications(server)).length).toBe(0);
    await server.stop();
  });

  it("ignores a bare @ word that is not a handle", async () => {
    const server = await start();
    await hostPost(server, "email me @ home if you like");
    expect((await notifications(server)).length).toBe(0);
    await server.stop();
  });

  it("does not notify the author about their own status", async () => {
    const server = await start();
    // The bot posts a status mentioning the player; the bot's own queue
    // must stay empty.
    await fetch(`${server.baseUrl}/api/v1/statuses`, {
      method: "POST",
      headers: { ...BOT_AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "@player your move" }),
    });
    expect((await notifications(server)).length).toBe(0);
    await server.stop();
  });
});
