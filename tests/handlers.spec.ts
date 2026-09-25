import { describe, expect, it, vi } from "vitest";
import { handlePublicCommand } from "../src/handlers/publicCommand.js";
import { handleDm } from "../src/handlers/directMessage.js";
import { MastodonApiError } from "../src/mastodon/client.js";
import { m } from "../src/i18n/index.js";
import { accept, count, gameRow, input, newGame, useHarness } from "./support.js";

/** create → accept → submit through the handlers (Mastodon mocked, no network). */
describe("handlers integration", () => {
  const h = useHarness();
  const inviteOf = (accountId: string) =>
    (h.db.prepare("SELECT invite_status FROM players WHERE account_id = ?").get(accountId) as { invite_status: string })
      .invite_status;
  const recipients = () => h.posts.map((p) => [p.body.visibility, p.body.status!.split(" ")[0]]);

  it("creates game from mention: replies on creation post, DMs challengers", async () => {
    const result = await newGame(h.deps, ["alice", "bob"]);

    expect(result).toMatchObject({ handled: true, kind: "game_created" });
    expect(h.posts).toHaveLength(3);
    expect(h.posts[0]!.body.in_reply_to_id).toBe("s-create");
    expect(recipients().slice(1)).toEqual([
      ["direct", "@alice@mastodon.example"],
      ["direct", "@bob@mastodon.example"],
    ]);
    expect(h.db.prepare("SELECT status FROM games").all()).toEqual([{ status: "INVITED" }]);
    expect(h.db.prepare("SELECT account_id, invite_status FROM players ORDER BY account_id").all()).toEqual([
      { account_id: "id-alice", invite_status: "pending" },
      { account_id: "id-bob", invite_status: "pending" },
      { account_id: "id-host", invite_status: "accepted" },
    ]);
  });

  it("preserves private visibility for command replies", async () => {
    await handlePublicCommand(input("id-host", "<p>@playlistbattle status</p>", { visibility: "private" }), h.deps);
    expect(h.posts[0]!.body.visibility).toBe("private");
  });

  it("rejects a private newgame before creating a game", async () => {
    const result = await handlePublicCommand(
      input("id-host", '<p>@playlistbattle newgame "80s Synth" 8 @alice</p>', { visibility: "private" }),
      h.deps,
    );
    expect(result).toMatchObject({ handled: true, kind: "error" });
    expect(recipients()).toEqual([["private", expect.any(String)]]);
    expect(count(h.db, "games")).toBe(0);
  });

  it.each([
    ["an out-of-range length", '"X" 3 @alice'],
    ["an overlong theme", `"${"x".repeat(121)}" 8 @alice`],
  ])("rejects a create with %s: one error reply, no game or invitations", async (_, args) => {
    const result = await handlePublicCommand(input("id-host", `<p>@playlistbattle newgame ${args}</p>`), h.deps);
    expect(result).toMatchObject({ handled: true, kind: "error" });
    expect(h.posts).toHaveLength(1);
    expect(count(h.db, "games")).toBe(0);
  });

  it("accepts a remote host mention (federated host)", async () => {
    const result = await handlePublicCommand(
      input("id-remotehost", '<p>@playlistbattle newgame "X" 8 @alice</p>', { accountAcct: "remotehost@faraway.social" }),
      h.deps,
    );
    expect(result).toMatchObject({ handled: true, kind: "game_created" });
    expect(h.db.prepare("SELECT acct FROM players WHERE role = 'host'").all()).toEqual([
      { acct: "remotehost@faraway.social" },
    ]);
  });

  it("accepts remote challengers via lookup (federated players)", async () => {
    h.deps.lookup = vi.fn(async (acct: string) => ({ id: `id-${acct}`, acct: `${acct}@remote.social` }));
    expect(await newGame(h.deps, ["alice", "bob"])).toMatchObject({ kind: "game_created" });
    expect(h.db.prepare("SELECT acct FROM players WHERE role = 'challenger' ORDER BY acct").all()).toEqual([
      { acct: "alice@remote.social" },
      { acct: "bob@remote.social" },
    ]);
  });

  it("returns a specific error, not the generic one, when a challenger lookup 404s", async () => {
    h.deps.lookup = vi.fn(async () => {
      throw new MastodonApiError(404, { error: "Record not found" });
    });
    const result = await handlePublicCommand(
      input(
        "id-saiugol",
        "<p>@<span>playlistbattle</span> newgame &quot;test&quot; 8 @<span>alice@remote.social</span></p>",
      ),
      h.deps,
    );
    expect(result).toMatchObject({ kind: "error" });
    expect(JSON.stringify(result)).toContain("remote.social");
    expect(JSON.stringify(result)).not.toContain(m().unexpectedCreateError());
  });

  it("challenger accepts within the window → COLLECTING, confirmation + submission prompts by DM", async () => {
    await newGame(h.deps, ["alice", "bob"]);
    h.posts.length = 0;

    expect(await handleDm(input("id-alice", "<p>accept</p>"), h.deps)).toMatchObject({
      handled: true,
      kind: "accepted",
    });
    expect(inviteOf("id-alice")).toBe("accepted");
    expect(gameRow(h.db, "game-1").status).toBe("COLLECTING");
    // confirmation to alice, then submission prompts to every accepted player (bob is still pending)
    expect(recipients()).toEqual([
      ["direct", "@alice@mastodon.example"],
      ["direct", "@host@mastodon.example"],
      ["direct", "@alice@mastodon.example"],
    ]);
  });

  it("rejects an accept that arrives after the acceptance deadline", async () => {
    await newGame(h.deps);
    // Deadline passed but the sweep has not expired the invite yet (the 60s sweep race).
    h.db.prepare("UPDATE games SET acceptance_deadline = '2026-09-21T11:00:00.000Z'").run();

    expect(await handleDm(input("id-alice", "accept"), h.deps)).toMatchObject({
      handled: true,
      kind: "no_invitation",
    });
    expect(inviteOf("id-alice")).toBe("pending");
    expect(gameRow(h.db, "game-1").status).toBe("INVITED");
  });

  it("keeps the first-accept deadline when the confirmation DM fails", async () => {
    await newGame(h.deps);
    h.client.post.mockRejectedValueOnce(new Error("DM unavailable"));
    await handleDm(input("id-alice", "<p>accept</p>"), h.deps);

    expect(gameRow(h.db, "game-1")).toMatchObject({ status: "COLLECTING", submission_deadline: expect.any(String) });
  });

  it("decline via DM marks declined", async () => {
    await newGame(h.deps);
    expect(await handleDm(input("id-alice", "<p>decline</p>"), h.deps)).toMatchObject({ kind: "declined" });
    expect(inviteOf("id-alice")).toBe("declined");
  });

  it("host submission via DM stores tune with resolved title", async () => {
    await newGame(h.deps);
    await accept(h.deps, "id-alice");
    h.posts.length = 0;

    const result = await handleDm(input("id-host", "<p>https://youtu.be/dQw4w9WgXcQ</p>"), h.deps);

    expect(result).toMatchObject({ handled: true, kind: "tune_accepted" });
    expect(h.db.prepare("SELECT account_id, position, video_id, title FROM tunes").all()).toEqual([
      { account_id: "id-host", position: 1, video_id: "dQw4w9WgXcQ", title: "Title for dQw4w9WgXcQ" },
    ]);
    expect(h.texts().at(-1)).toContain("Title for dQw4w9WgXcQ");
  });

  it("collects a playlist link sent as a reply to the bot's DM", async () => {
    await newGame(h.deps);
    await accept(h.deps, "id-alice");

    const result = await handleDm(input("id-alice", "<p>https://youtu.be/aaaaaaaaaaa</p>", { inReplyToId: "s-2" }), h.deps);

    expect(result).toMatchObject({ handled: true, kind: "tune_accepted" });
    expect(count(h.db, "tunes")).toBe(1);
  });

  it("rejects non-YouTube link without counting it", async () => {
    await newGame(h.deps);
    await accept(h.deps, "id-alice");

    const result = await handleDm(input("id-host", "<p>https://vimeo.com/12345</p>"), h.deps);

    expect(result).toMatchObject({ kind: "tune_rejected" });
    expect(count(h.db, "tunes")).toBe(0);
  });

  it("status command replies with game summary", async () => {
    await newGame(h.deps, ["alice"], "80s Synth");
    h.posts.length = 0;

    const result = await handlePublicCommand(input("id-host", "<p>@playlistbattle status</p>"), h.deps);

    expect(result).toMatchObject({ kind: "status" });
    expect(h.texts()).toEqual([expect.stringContaining("80s Synth")]);
  });
});
