import { describe, it, expect, beforeEach } from "vitest";
import { MockMastodonServer } from "../test/integration/mock-mastodon.js";

/**
 * The driver's DM check reads /conversations, and it clears notifications
 * between phases with POST /notifications/clear. Both were missing, and both
 * surfaced as a bare 404 that the lifecycle reported as "create — never
 * happened" - an error message that points at the bot rather than at an
 * incomplete fake.
 *
 *   REST::ConversationSerializer - id, unread, accounts, last_status
 *   NotificationsController#clear - 422 with an empty array
 */

const AUTH = { Authorization: "Bearer mock-token" };
type Json = Record<string, unknown>;
const jsonOf = async (res: Response) => (await res.json()) as Json;

async function start() {
  const server = new MockMastodonServer({
    botAcct: "bot@mock.social",
    hostAcct: "host@mock.social",
    playerAcct: "player@mock.social",
  });
  await server.start();
  return server;
}

async function post(server: MockMastodonServer, body: Json): Promise<Json> {
  const res = await fetch(`${server.baseUrl}/api/v1/statuses`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return jsonOf(res);
}

describe("MockMastodon: conversations", () => {
  let server: MockMastodonServer;
  beforeEach(async () => {
    server = await start();
  });

  it("returns an array, empty when there is no direct message", async () => {
    const res = await fetch(`${server.baseUrl}/api/v1/conversations?limit=40`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("includes a conversation once a direct status is posted", async () => {
    const player = await jsonOf(
      await fetch(`${server.baseUrl}/api/v1/accounts/lookup?acct=player`, {
        headers: AUTH,
      }),
    );
    // A direct status names its recipient with `mentions`, the way the bot
    // addresses a DM. Without a participant other than the author there is
    // no conversation to find, so the acct has to be carried on the wire.
    await post(server, {
      status: "psst",
      visibility: "direct",
      mentions: [player.acct],
    });
    const res = await fetch(`${server.baseUrl}/api/v1/conversations?limit=40`, {
      headers: AUTH,
    });
    const body = (await res.json()) as Json[];
    expect(body.length).toBeGreaterThanOrEqual(1);
    const convo = body[0];
    if (convo === undefined) throw new Error("expected a conversation");
    // attributes :id, :unread
    expect(typeof convo.id).toBe("string");
    expect(typeof convo.unread).toBe("boolean");
    // has_many :participant_accounts, key: :accounts
    expect(Array.isArray(convo.accounts)).toBe(true);
    // has_one :last_status
    expect(convo.last_status).toBeDefined();
    // The addressed player must be a participant.
    const accts = convo.accounts as Array<{ id: string }>;
    expect(accts.map((a) => a.id)).toContain(player.id);
  });
});

describe("MockMastodon: clear notifications", () => {
  let server: MockMastodonServer;
  beforeEach(async () => {
    server = await start();
  });

  it("accepts POST /notifications/clear and empties the queue", async () => {
    server.pushNotification({ type: "mention", fromAcct: "host@mock.social" });
    const before = (
      (await (
        await fetch(`${server.baseUrl}/api/v1/notifications?limit=40`, { headers: AUTH })
      ).json()) as Json[]
    ).length;
    expect(before).toBeGreaterThan(0);

    const res = await fetch(`${server.baseUrl}/api/v1/notifications/clear`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    const after = (
      (await (
        await fetch(`${server.baseUrl}/api/v1/notifications?limit=40`, { headers: AUTH })
      ).json()) as Json[]
    ).length;
    expect(after).toBe(0);
  });
});
