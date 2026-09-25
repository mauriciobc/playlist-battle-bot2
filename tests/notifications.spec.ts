import { describe, expect, it } from "vitest";
import { classifyNotification, advance, type NotificationCursor } from "../src/mastodon/notifications.js";

const baseMention = {
  id: "n1",
  type: "mention",
  created_at: "2026-09-21T12:00:00.000Z",
  account: { id: "u1", acct: "alice", username: "alice" },
  status: {
    id: "s1",
    visibility: "public",
    in_reply_to_id: null,
    content: "<p>@playlistbattle newgame</p>",
    mentions: [{ id: "bot", username: "playlistbattle", acct: "playlistbattle" }],
  },
};

const classify = (n: object) => classifyNotification(n as never, "playlistbattle");
const withStatus = (over: object) => classify({ ...baseMention, status: { ...baseMention.status, ...over } });

describe("classifyNotification", () => {
  it.each(["public", "unlisted", "private"])("classifies a %s mention as public_command, keeping visibility", (visibility) => {
    expect(withStatus({ visibility })).toMatchObject({
      kind: "public_command",
      statusId: "s1",
      accountId: "u1",
      visibility,
    });
  });

  it("classifies direct-visibility mention as dm", () => {
    expect(withStatus({ visibility: "direct", in_reply_to_id: "s0" })).toMatchObject({
      kind: "dm",
      statusId: "s1",
      accountId: "u1",
      inReplyToId: "s0",
    });
  });

  it("rejects unknown visibility instead of defaulting to public", () => {
    expect(withStatus({ visibility: "limited" })).toBeNull();
  });

  it("ignores mentions that do not target the bot", () => {
    expect(withStatus({ mentions: [{ id: "x", username: "someone", acct: "someone" }] })).toBeNull();
  });

  it("passes through poll-expiry notifications", () => {
    const poll = { id: "n9", type: "poll", created_at: "x", account: baseMention.account, status: null };
    expect(classify(poll)).toMatchObject({ kind: "poll_expired", statusId: null });
  });

  it.each(["follow", "favourite", "reblog", "status", "mention"])(
    "returns null for a status-less %s notification",
    (type) => {
      expect(classify({ id: "n", type, created_at: "x", account: baseMention.account, status: null })).toBeNull();
    },
  );
});

describe("cursor advance (PRD §7 restart safety)", () => {
  it("advanceCursor only moves forward, comparing ids numerically", () => {
    let cursor: NotificationCursor = { lastId: "100" };
    cursor = advance("50", cursor);
    expect(cursor.lastId).toBe("100");
    cursor = advance("200", cursor);
    expect(cursor.lastId).toBe("200");
  });

  it("an empty cursor takes the first id", () => {
    expect(advance("200", { lastId: "" })).toEqual({ lastId: "200" });
  });
});
