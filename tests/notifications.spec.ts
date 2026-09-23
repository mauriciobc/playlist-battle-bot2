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

describe("classifyNotification", () => {
  it("classifies public mention as public_command", () => {
    const r = classifyNotification(baseMention as never, "playlistbattle");
    expect(r).toMatchObject({ kind: "public_command", statusId: "s1", accountId: "u1" });
  });

  it("preserves unlisted and private command visibility", () => {
    for (const visibility of ["unlisted", "private"] as const) {
      const status = { ...baseMention.status, visibility };
      const r = classifyNotification({ ...baseMention, status } as never, "playlistbattle");
      expect(r).toMatchObject({ kind: "public_command", visibility });
    }
  });

  it("rejects unknown visibility instead of defaulting to public", () => {
    const status = { ...baseMention.status, visibility: "limited" };
    expect(classifyNotification({ ...baseMention, status } as never, "playlistbattle")).toBeNull();
  });

  it("classifies direct-visibility mention as dm", () => {
    const dm = {
      ...baseMention,
      status: { ...baseMention.status, visibility: "direct", in_reply_to_id: "s0" },
    };
    const r = classifyNotification(dm as never, "playlistbattle");
    expect(r).toMatchObject({ kind: "dm", statusId: "s1", accountId: "u1", inReplyToId: "s0" });
  });

  it("ignores mentions that do not target the bot", () => {
    const other = {
      ...baseMention,
      status: {
        ...baseMention.status,
        mentions: [{ id: "x", username: "someone", acct: "someone" }],
      },
    };
    expect(classifyNotification(other as never, "playlistbattle")).toBeNull();
  });

  it("passes through poll-expiry notifications", () => {
    const poll = { id: "n9", type: "poll", created_at: "x", account: baseMention.account, status: null };
    expect(classifyNotification(poll as never, "playlistbattle")).toMatchObject({
      kind: "poll_expired",
      statusId: null,
    });
  });

  it("returns null for irrelevant types (follow, favourite, etc.)", () => {
    for (const type of ["follow", "favourite", "reblog", "status"]) {
      const n = { id: "n", type, created_at: "x", account: baseMention.account, status: null };
      expect(classifyNotification(n as never, "playlistbattle")).toBeNull();
    }
  });

  it("handles mention with no status gracefully", () => {
    const n = { id: "n", type: "mention", created_at: "x", account: baseMention.account, status: null };
    expect(classifyNotification(n as never, "playlistbattle")).toBeNull();
  });
});

describe("cursor advance (PRD §7 restart safety)", () => {
  it("advanceCursor only moves forward", () => {
    let cursor: NotificationCursor = { lastId: "100" };
    cursor = advance("50", cursor);
    expect(cursor.lastId).toBe("100");
    cursor = advance("200", cursor);
    expect(cursor.lastId).toBe("200");
  });
});
