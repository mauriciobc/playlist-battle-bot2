import { describe, it, expect, beforeEach } from "vitest";
import { MockMastodonServer } from "../test/integration/mock-mastodon.js";

/**
 * Found by running the real bot, not by reading the serializers.
 *
 * classifyNotification (src/mastodon/notifications.ts) decides whether to act
 * on a notification with:
 *
 *   n.status.mentions.some((m) => m.username.toLowerCase() === botAcct)
 *
 * It does NOT parse the status text and does NOT trust the notification
 * alone - it reads the status's `mentions` array, exactly as
 * REST::StatusSerializer emits it (MentionSerializer: id, username, url,
 * acct). The mock always returned `mentions: []`, so every newgame the bot
 * received was classified as "not addressed to bot", processNotification
 * returned early, the cursor advanced, and the game was silently dropped.
 *
 * Upstream: app/serializers/rest/status_serializer.rb
 *   has_many :ordered_mentions, key: :mentions
 *     -> MentionSerializer attributes :id, :username, :url, :acct
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

const hostPost = (server: MockMastodonServer, text: string) =>
  fetch(`${server.baseUrl}/api/v1/statuses`, {
    method: "POST",
    headers: { Authorization: "Bearer host-token", "Content-Type": "application/json" },
    body: JSON.stringify({ status: text }),
  });

describe("status mentions array (REST::StatusSerializer)", () => {
  let server: MockMastodonServer;
  beforeEach(async () => {
    server = await start();
  });

  it("lists the mentioned account with id, username, url and acct", async () => {
    const created = await jsonOf(await hostPost(server, "@bot newgame round"));
    const mentions = created.mentions as Array<Record<string, unknown>>;
    expect(mentions.length).toBe(1);
    // MentionSerializer attributes: :id, :username, :url, :acct
    expect(mentions[0]?.username).toBe("bot");
    expect(mentions[0]?.acct).toBe("bot@mock.social");
    expect(typeof mentions[0]?.id).toBe("string");
    expect(mentions[0]?.url).toBeDefined();
    await server.stop();
  });

  it("lists every mentioned account, deduplicated", async () => {
    const created = await jsonOf(await hostPost(server, "@bot duel @player"));
    const mentions = created.mentions as Array<{ username: string }>;
    expect(mentions.map((m) => m.username).sort()).toEqual(["bot", "player"]);
    await server.stop();
  });

  it("returns an empty mentions array for a status that mentions nobody", async () => {
    const created = await jsonOf(await hostPost(server, "just a note"));
    expect(created.mentions).toEqual([]);
    await server.stop();
  });

  it("keeps mentions on the notification's embedded status too", async () => {
    // The bot reads n.status.mentions - the status embedded in the
    // notification - so that copy has to carry it as well.
    await hostPost(server, "@bot newgame round");
    const n = (
      (await (
        await fetch(`${server.baseUrl}/api/v1/notifications?limit=5`, {
          headers: BOT_AUTH,
        })
      ).json()) as Json[]
    )[0];
    if (n === undefined) throw new Error("expected a notification");
    const status = n.status as Json;
    expect((status.mentions as Array<{ username: string }>)[0]?.username).toBe("bot");
    await server.stop();
  });
});
