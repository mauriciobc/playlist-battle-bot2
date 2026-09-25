import { describe, it, expect, beforeEach } from "vitest";
import type { MockMastodonServer } from "../test/integration/mock-mastodon.js";
import { AUTH, jsonOf, post, postJson, startMock, type Json } from "../test/integration/mock-kit.js";

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

describe("MockMastodon: conversations", () => {
  let server: MockMastodonServer;
  beforeEach(async () => {
    server = await startMock();
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
    server = await startMock();
  });

  it("accepts POST /notifications/clear and empties the queue", async () => {
    server.pushNotification({ type: "mention", fromAcct: "host@mock.social" });
    const count = async () =>
      (
        (await (
          await fetch(`${server.baseUrl}/api/v1/notifications?limit=40`, { headers: AUTH })
        ).json()) as Json[]
      ).length;
    expect(await count()).toBeGreaterThan(0);

    const res = await postJson(server, "/api/v1/notifications/clear", {});
    expect(res.status).toBe(200);

    expect(await count()).toBe(0);
  });
});
