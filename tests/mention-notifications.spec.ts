import { describe, it, expect, beforeEach } from "vitest";
import type { MockMastodonServer } from "../test/integration/mock-mastodon.js";
import { AUTH, post, startMock, type Json } from "../test/integration/mock-kit.js";

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
 * and must not when it does not. The driver posts as the host, so the tests
 * do too: the bot's own token would make author == recipient.
 */

const botNotifications = async (server: MockMastodonServer) =>
  (await (
    await fetch(`${server.baseUrl}/api/v1/notifications?limit=10`, { headers: AUTH })
  ).json()) as Json[];

describe("mention notifications", () => {
  let server: MockMastodonServer;
  beforeEach(async () => {
    server = await startMock();
  });

  it("creates a mention notification when a status addresses the bot", async () => {
    await post(server, { status: "@bot newgame round 1", mentions: ["bot"] }, "host-token");
    const body = await botNotifications(server);
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
    await post(server, { status: "just a public note" }, "host-token");
    expect((await botNotifications(server)).length).toBe(0);
  });

  it("does not notify a status that mentions only the other player", async () => {
    await post(server, { status: "@player your turn", mentions: ["player"] }, "host-token");
    expect((await botNotifications(server)).length).toBe(0);
  });
});
