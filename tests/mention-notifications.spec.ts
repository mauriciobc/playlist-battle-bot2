import { describe, it, expect, beforeEach } from "vitest";
import { MockMastodonServer } from "../test/integration/mock-mastodon.js";

/**
 * The gap that made every end-to-end run fail at "create".
 *
 * The bot is notification-driven: it reacts to a mention notification, not to
 * a status it can see. A newgame posted by the driver mentions the bot, so on
 * real Mastodon that produces a `mention` notification and the bot's poll
 * loop picks it up. The mock stored the status and generated nothing, so the
 * bot polled an empty queue forever and the driver's backstop fired.
 *
 * Upstream, the pairing is:
 *   app/models/notification.rb - types include :mention
 *   app/services/post_status_service.rb / Status - parse_mentions resolves
 *     @handle mentions against local accounts and creates the notification
 *   REST::NotificationSerializer - type: "mention", account = the author,
 *     status = the mentioning status
 *
 * So the mock must create the notification when a status mentions the bot,
 * and must not when it does not.
 */

const BOT_AUTH = { Authorization: "Bearer mock-token" };
/**
 * The author must differ from the recipient: a mention notification is
 * delivered to the account being mentioned, and the bot's own token would
 * make author == recipient. The driver posts as the host, so the tests do too.
 */
const HOST_AUTH = { Authorization: "Bearer host-token" };
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

async function post(
  server: MockMastodonServer,
  body: Json,
  auth: Record<string, string> = HOST_AUTH,
): Promise<Response> {
  return fetch(`${server.baseUrl}/api/v1/statuses`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("mention notifications", () => {
  let server: MockMastodonServer;
  beforeEach(async () => {
    server = await start();
  });

  it("creates a mention notification when a status addresses the bot", async () => {
    await post(server, { status: "@bot newgame round 1", mentions: ["bot"] });
    const res = await fetch(`${server.baseUrl}/api/v1/notifications?limit=10`, {
      headers: BOT_AUTH,
    });
    const body = (await res.json()) as Json[];
    expect(body.length).toBe(1);
    const n = body[0];
    if (n === undefined) throw new Error("expected a notification");
    expect(n.type).toBe("mention");
    // attributes :id, :type, :created_at, :group_key are unconditional
    expect(n.id).toBeDefined();
    expect(n.created_at).toBeDefined();
    expect(n.group_key).toBeDefined();
    // belongs_to :from_account, key: :account
    expect((n.account as Json).acct).toBe("host@mock.social");
    // belongs_to :target_status, key: :status, if: :status_type?
    expect(n.status).toBeDefined();
  });

  it("creates no notification for a status that does not mention the bot", async () => {
    await post(server, { status: "just a public note" });
    const res = await fetch(`${server.baseUrl}/api/v1/notifications?limit=10`, {
      headers: BOT_AUTH },
    );
    expect(((await res.json()) as Json[]).length).toBe(0);
  });

  it("does not notify a status that mentions only the other player", async () => {
    await post(server, { status: "@player your turn", mentions: ["player"] });
    const res = await fetch(`${server.baseUrl}/api/v1/notifications?limit=10`, {
      headers: BOT_AUTH,
    });
    expect(((await res.json()) as Json[]).length).toBe(0);
  });

  it("honours since_id so a poll loop does not replay old notifications", async () => {
    await post(server, { status: "@bot first", mentions: ["bot"] });
    const all = (await (
      await fetch(`${server.baseUrl}/api/v1/notifications?limit=10`, { headers: BOT_AUTH })
    ).json()) as Json[];
    const firstId = all[0]?.id;
    if (firstId === undefined) throw new Error("expected a notification");
    await post(server, { status: "@bot second", mentions: ["bot"] });
    const since = (await (
      await fetch(`${server.baseUrl}/api/v1/notifications?since_id=${firstId}`, {
        headers: BOT_AUTH,
      })
    ).json()) as Json[];
    expect(since.length).toBe(1);
    expect(since.every((n) => n.id !== firstId)).toBe(true);
  });
});
