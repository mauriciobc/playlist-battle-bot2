import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, migrate, type Db } from "../src/db/index.js";
import { handlePublicCommand, handleDm, type HandlerDeps } from "../src/handlers/mention.js";
import type { MastodonClient } from "../src/mastodon/client.js";

/**
 * Phase 4 integration: drive create → accept → submit through handlers
 * with a mocked Mastodon client (no network).
 */

type Posted = { path: string; body: unknown };

function mockClient(posts: Posted[]) {
  return {
    get: vi.fn(async () => ({ id: "bot", acct: "playlistbattle" })),
    getWithLink: vi.fn(async () => ({ data: [], linkNext: null })),
    post: vi.fn(async (path: string, body?: unknown) => {
      posts.push({ path, body });
      const id = `status-${posts.length}`;
      const b = body as { poll?: unknown } | undefined;
      if (b?.poll) {
        return { id, poll: { id: `poll-${posts.length}`, expires_at: "2026-09-22T12:00:00.000Z" } };
      }
      return { id, visibility: "public" };
    }),
    rateLimit: null,
  } as unknown as MastodonClient;
}

describe("handlers integration", () => {
  let dir: string;
  let db: Db;
  let posts: Posted[];
  let client: MastodonClient;
  let deps: HandlerDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pb-handlers-"));
    db = openDatabase(join(dir, "test.db"));
    migrate(db);
    posts = [];
    client = mockClient(posts);
    deps = {
      db,
      client,
      botAcct: "playlistbattle",
      instanceDomain: "mastodon.example",
      pollDurationSec: 86400,
      acceptanceWindowSec: 86400,
      submissionWindowSec: 172800,
      creationCooldownSec: 600,
      maxGamesPerPlayer: 3,
      lookup: vi.fn(async (acct: string) => ({
        id: `id-${acct}`,
        acct: acct.includes("@") ? acct : `${acct}@mastodon.example`,
        username: acct.split("@")[0]!,
        local: !acct.includes("@") || acct.endsWith("@mastodon.example"),
      })),
      resolveTitle: vi.fn(async (videoId: string) => ({
        videoId,
        title: `Title for ${videoId}`,
        author: "Artist",
        canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      })),
      checkAvailable: vi.fn(async () => true),
      publishBattlePlaylist: vi.fn(async () => null),
      replacementGraceMin: 15,
      now: () => new Date("2026-09-21T12:00:00Z"),
      newGameId: () => `game-${Math.random().toString(36).slice(2, 8)}`,
    };
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function createViaMention() {
    return handlePublicCommand(
      {
        accountId: "id-host",
        accountAcct: "host",
        statusId: "s-create",
        content: `<p>@playlistbattle newgame "80s Synth" 8 @alice @bob</p>`,
        inReplyToId: null,
      },
      deps,
    );
  }

  it("creates game from mention: replies on creation post, DMs challengers", async () => {
    const result = await createViaMention();
    expect(result).toMatchObject({ handled: true, kind: "game_created" });
    // creation post reply + DM to alice + DM to bob
    expect(posts.length).toBe(3);
    expect(posts[0]!.path).toBe("/api/v1/statuses");
    const replyBody = posts[0]!.body as { in_reply_to_id: string; visibility: string };
    expect(replyBody.in_reply_to_id).toBe("s-create");
    // DMs use direct visibility
    const dmBodies = posts.slice(1).map((p) => p.body as { visibility: string; status: string });
    expect(dmBodies.every((b) => b.visibility === "direct")).toBe(true);
    expect(dmBodies[0]!.status).toMatch(/^@alice\b/);
    expect(dmBodies[1]!.status).toMatch(/^@bob\b/);

    const games = db.prepare("SELECT * FROM games").all() as { id: string; status: string }[];
    expect(games).toHaveLength(1);
    expect(games[0]!.status).toBe("INVITED");

    const players = db.prepare("SELECT * FROM players").all() as { account_id: string; invite_status: string }[];
    expect(players).toHaveLength(3);
    expect(players.find((p) => p.account_id === "id-host")?.invite_status).toBe("accepted");
    expect(players.filter((p) => p.invite_status === "pending")).toHaveLength(2);
  });

  it("preserves private visibility for command replies", async () => {
    await handlePublicCommand(
      {
        accountId: "id-host",
        accountAcct: "host",
        statusId: "s-private",
        content: "<p>@playlistbattle status</p>",
        inReplyToId: null,
        visibility: "private",
      },
      deps,
    );
    const body = posts[0]!.body as { visibility: string };
    expect(body.visibility).toBe("private");
  });

  it("rejects a private newgame before creating a game", async () => {
    const result = await handlePublicCommand(
      {
        accountId: "id-host",
        accountAcct: "host",
        statusId: "s-private-create",
        content: '<p>@playlistbattle newgame "80s Synth" 8 @alice</p>',
        inReplyToId: null,
        visibility: "private",
      },
      deps,
    );
    expect(result).toMatchObject({ handled: true, kind: "error" });
    expect(posts).toHaveLength(1);
    expect((posts[0]!.body as { visibility: string }).visibility).toBe("private");
    expect(db.prepare("SELECT COUNT(*) AS c FROM games").get()).toEqual({ c: 0 });
  });

  it("rejects an overlong theme before creating or sending invitations", async () => {
    const result = await handlePublicCommand(
      {
        accountId: "id-host",
        accountAcct: "host",
        statusId: "s-long-theme",
        content: `<p>@playlistbattle newgame "${"x".repeat(121)}" 8 @alice</p>`,
        inReplyToId: null,
      },
      deps,
    );
    expect(result).toMatchObject({ handled: true, kind: "error" });
    expect(posts).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS c FROM games").get()).toEqual({ c: 0 });
  });

  it("rejects invalid create with helpful reply (no game row)", async () => {
    const result = await handlePublicCommand(
      {
        accountId: "id-host",
        accountAcct: "host",
        statusId: "s-bad",
        content: `<p>@playlistbattle newgame "X" 3 @alice</p>`,
        inReplyToId: null,
      },
      deps,
    );
    expect(result).toMatchObject({ handled: true, kind: "error" });
    expect(db.prepare("SELECT COUNT(*) AS c FROM games").get()).toEqual({ c: 0 });
    // one reply explaining the error
    expect(posts).toHaveLength(1);
  });

  it("rejects a remote host mention (same-instance only)", async () => {
    const result = await handlePublicCommand(
      {
        accountId: "id-remotehost",
        accountAcct: "remotehost@faraway.social",
        statusId: "s-remote",
        content: `<p>@playlistbattle newgame "X" 8 @alice</p>`,
        inReplyToId: null,
      },
      { ...deps, lookup: async () => ({ id: "id-alice", acct: "alice", username: "alice", local: true }) },
    );
    expect(result).toMatchObject({ handled: true, kind: "error" });
    expect(db.prepare("SELECT COUNT(*) AS c FROM games").get()).toEqual({ c: 0 });
    const body = posts[0]!.body as { status: string };
    expect(body.status).toMatch(/local/i);
  });

  it("accepts a pending challenger within the window", async () => {
    await createViaMention();
    const aliceId = db
      .prepare(`SELECT account_id FROM players WHERE acct = 'alice'`)
      .get() as { account_id: string };
    const result = await handleDm(
      { accountId: aliceId.account_id, accountAcct: "alice", statusId: "dm1", content: "accept", inReplyToId: null },
      deps,
    );
    expect(result).toMatchObject({ handled: true, kind: "accepted" });
    const st = db
      .prepare(`SELECT invite_status FROM players WHERE acct = 'alice'`)
      .get() as { invite_status: string };
    expect(st.invite_status).toBe("accepted");
    const g = db.prepare("SELECT status FROM games").get() as { status: string };
    expect(g.status).toBe("COLLECTING");
  });

  it("rejects an accept that arrives after the acceptance deadline", async () => {
    await createViaMention();
    const aliceId = db
      .prepare(`SELECT account_id FROM players WHERE acct = 'alice'`)
      .get() as { account_id: string };
    // Backdate the window so the sweep has not yet expired the invite but the
    // deadline has already passed (the 60s sweep race the fix closes).
    db.prepare("UPDATE games SET acceptance_deadline = '2026-09-21T11:00:00.000Z'").run();
    const result = await handleDm(
      { accountId: aliceId.account_id, accountAcct: "alice", statusId: "dm1", content: "accept", inReplyToId: null },
      deps,
    );
    expect(result).toMatchObject({ handled: true, kind: "no_invitation" });
    const st = db
      .prepare(`SELECT invite_status FROM players WHERE acct = 'alice'`)
      .get() as { invite_status: string };
    expect(st.invite_status).toBe("pending");
    const g = db.prepare("SELECT status FROM games").get() as { status: string };
    expect(g.status).toBe("INVITED");
  });

  it("rejects remote challenger via lookup", async () => {
    deps.lookup = vi.fn(async (acct: string) => ({
      id: `id-${acct}`,
      acct: `${acct}@remote.social`,
      username: acct,
      local: false,
    }));
    const result = await createViaMention();
    expect(result).toMatchObject({ kind: "error" });
    expect(db.prepare("SELECT COUNT(*) AS c FROM games").get()).toEqual({ c: 0 });
  });

  it("challenger DM accept → COLLECTING, bot DMs submission prompt", async () => {
    await createViaMention();
    posts.length = 0;

    const result = await handleDm(
      {
        accountId: "id-alice",
        accountAcct: "alice",
        statusId: "s-accept",
        content: "<p>accept</p>",
        inReplyToId: null,
      },
      deps,
    );
    expect(result).toMatchObject({ handled: true, kind: "accepted" });

    const game = db.prepare("SELECT status FROM games LIMIT 1").get() as { status: string };
    expect(game.status).toBe("COLLECTING");

    // confirmation DM to alice + submission prompts to host, alice, bob
    expect(posts.length).toBeGreaterThanOrEqual(3);
    const direct = posts.filter((p) => (p.body as { visibility: string }).visibility === "direct");
    expect(direct.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps the first-accept deadline when the confirmation DM fails", async () => {
    await createViaMention();
    (client.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("DM unavailable"));
    await handleDm(
      {
        accountId: "id-alice",
        accountAcct: "alice",
        statusId: "s-accept-failure",
        content: "<p>accept</p>",
        inReplyToId: null,
      },
      deps,
    );
    const game = db.prepare("SELECT status, submission_deadline FROM games").get() as {
      status: string;
      submission_deadline: string | null;
    };
    expect(game.status).toBe("COLLECTING");
    expect(game.submission_deadline).toBeTruthy();
  });

  it("host submission via DM stores tune with resolved title", async () => {
    await createViaMention();
    await handleDm(
      { accountId: "id-alice", accountAcct: "alice", statusId: "s1", content: "<p>accept</p>", inReplyToId: null },
      deps,
    );
    // accept bob too
    await handleDm(
      { accountId: "id-bob", accountAcct: "bob", statusId: "s2", content: "<p>accept</p>", inReplyToId: null },
      deps,
    );
    posts.length = 0;

    const result = await handleDm(
      {
        accountId: "id-host",
        accountAcct: "host",
        statusId: "s3",
        content: "<p>https://youtu.be/dQw4w9WgXcQ</p>",
        inReplyToId: null,
      },
      deps,
    );
    expect(result).toMatchObject({ handled: true, kind: "tune_accepted" });

    const tunes = db.prepare("SELECT * FROM tunes").all() as {
      account_id: string;
      position: number;
      video_id: string;
      title: string;
    }[];
    expect(tunes).toHaveLength(1);
    expect(tunes[0]).toMatchObject({
      account_id: "id-host",
      position: 1,
      video_id: "dQw4w9WgXcQ",
      title: "Title for dQw4w9WgXcQ",
    });
    // confirmation includes resolved title
    const lastPost = posts.at(-1)!.body as { status: string };
    expect(lastPost.status).toContain("Title for dQw4w9WgXcQ");
  });

  it("rejects non-YouTube link without counting it", async () => {
    await createViaMention();
    await handleDm(
      { accountId: "id-alice", accountAcct: "alice", statusId: "s-acc", content: "<p>accept</p>", inReplyToId: null },
      deps,
    );
    posts.length = 0;
    const result = await handleDm(
      {
        accountId: "id-host",
        accountAcct: "host",
        statusId: "sx",
        content: "<p>https://vimeo.com/12345</p>",
        inReplyToId: null,
      },
      deps,
    );
    expect(result).toMatchObject({ kind: "tune_rejected" });
    expect(db.prepare("SELECT COUNT(*) AS c FROM tunes").get()).toEqual({ c: 0 });
  });

  it("status command replies with game summary", async () => {
    await createViaMention();
    posts.length = 0;
    const result = await handlePublicCommand(
      {
        accountId: "id-host",
        accountAcct: "host",
        statusId: "s-status",
        content: "<p>@playlistbattle status</p>",
        inReplyToId: null,
      },
      deps,
    );
    expect(result).toMatchObject({ kind: "status" });
    expect(posts).toHaveLength(1);
    const body = posts[0]!.body as { status: string };
    expect(body.status).toMatch(/80s Synth|INVITED|invited/i);
  });

  it("decline via DM marks declined", async () => {
    await createViaMention();
    const result = await handleDm(
      { accountId: "id-alice", accountAcct: "alice", statusId: "s-d", content: "<p>decline</p>", inReplyToId: null },
      deps,
    );
    expect(result).toMatchObject({ kind: "declined" });
    const alice = db
      .prepare("SELECT invite_status FROM players WHERE account_id = ?")
      .get("id-alice") as { invite_status: string };
    expect(alice.invite_status).toBe("declined");
  });

  it("full setup: both challengers accept + all playlists complete → READY → ROUND_1 with poll (PRD §5.4/§5.5)", async () => {
    const created = await createViaMention();
    expect(created).toMatchObject({ kind: "game_created" });
    const gameId = (created as { detail: string }).detail;

    for (const acct of ["id-alice", "id-bob"]) {
      const r = await handleDm(
        { accountId: acct, accountAcct: acct.replace("id-", ""), statusId: `s-acc-${acct}`, content: "<p>accept</p>", inReplyToId: null },
        deps,
      );
      expect(r).toMatchObject({ kind: "accepted" });
    }

    // Each player submits 8 unique tunes via one-per-line fast path (PRD §5.3)
    for (const acct of ["id-host", "id-alice", "id-bob"]) {
      const links = Array.from(
        { length: 8 },
        (_, i) => `https://www.youtube.com/watch?v=${acct.replace(/[^a-z]/g, "").padEnd(9, "x")}${String(i).padStart(2, "0")}`,
      )
        .map((u) => u.slice(0, 43)) // ensure valid 11-char ids below
        .map((_, i) => `https://www.youtube.com/watch?v=${makeId(acct, i)}`)
        .join("\n");
      const r = await handleDm(
        { accountId: acct, accountAcct: acct.replace("id-", ""), statusId: `s-tunes-${acct}`, content: `<p>${links}</p>`, inReplyToId: null },
        deps,
      );
      expect(r).toMatchObject({ kind: "tune_accepted" });
    }

    const game = db.prepare("SELECT status, current_round FROM games WHERE id = ?").get(gameId) as {
      status: string;
      current_round: number;
    };
    expect(game.status).toBe("ROUND");
    expect(game.current_round).toBe(1);

    const rounds = db.prepare("SELECT * FROM rounds WHERE game_id = ?").all(gameId) as {
      number: number;
      status: string;
      poll_id: string;
      option_map_json: string;
    }[];
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.status).toBe("poll_open");
    expect(rounds[0]!.poll_id).toBeTruthy();
    const optionMap = JSON.parse(rounds[0]!.option_map_json) as Record<string, string>;
    expect(Object.keys(optionMap)).toHaveLength(3); // 3 players in poll

    // Outbound: duel start + announce + 3 tunes + poll present among posts after setup
    const pollPosts = posts.filter((p) => (p.body as { poll?: unknown }).poll);
    expect(pollPosts.length).toBeGreaterThanOrEqual(1);
    const pollBody = pollPosts.at(-1)!.body as { poll: { options: string[]; expires_in: number } };
    expect(pollBody.poll.options).toHaveLength(3);
    expect(pollBody.poll.expires_in).toBe(86400);
    for (const o of pollBody.poll.options) expect(o.length).toBeLessThanOrEqual(25);
  });
});

/** Deterministic 11-char YouTube-like ID per account+index. */
function makeId(acct: string, i: number): string {
  const base = acct.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().padEnd(8, "z");
  return `${base}${String(i).padStart(3, "0")}`.slice(0, 11);
}
