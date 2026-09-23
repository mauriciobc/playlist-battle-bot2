import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, migrate, type Db } from "../src/db/index.js";
import { checkAvailable } from "../src/youtube/oembed.js";
import type { BattlePlaylistPublisher } from "../src/youtube/playlist.js";
import { handleDm, handlePublicCommand, type HandlerDeps } from "../src/handlers/mention.js";
import { handlePlayerDeleted } from "../src/handlers/closure.js";
import { checkDeadlines } from "../src/scheduler/index.js";
import { emitFinale, emitRound } from "../src/scheduler/roundState.js";
import { m } from "../src/i18n/index.js";
import type { MastodonClient } from "../src/mastodon/client.js";
import { MastodonApiError } from "../src/mastodon/client.js";

function okJson(title = "Some Title") {
  return new Response(JSON.stringify({ title, author_name: "A" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ── checkAvailable (v1.1 1.4) ─────────────────────────────────────

describe("checkAvailable (v1.1 1.4)", () => {
  const VID = "dQw4w9WgXcQ";

  it("404 → false (unavailable)", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 404 }));
    await expect(checkAvailable(VID, { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toBe(false);
  });

  it("429 → true (fail-open, rate limited)", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429 }));
    await expect(checkAvailable(VID, { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toBe(true);
  });

  it("5xx → true (fail-open, transient)", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 503 }));
    await expect(checkAvailable(VID, { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toBe(true);
  });

  it("network error → true (fail-open)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(checkAvailable(VID, { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toBe(true);
  });

  it("200 with title → true", async () => {
    const fetchImpl = vi.fn(async () => okJson());
    await expect(checkAvailable(VID, { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toBe(true);
  });

  it("200 without title → false", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ provider_name: "YouTube" }), { status: 200 }),
    );
    await expect(checkAvailable(VID, { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toBe(false);
  });

  it("invalid video ID → false", async () => {
    const fetchImpl = vi.fn(async () => okJson());
    await expect(checkAvailable("!!!", { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never serves negatives from cache (live check despite cached title)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-av-cache-"));
    const db = openDatabase(join(dir, "t.db"));
    migrate(db);
    try {
      db.prepare(
        "INSERT INTO video_cache (video_id, title, author, fetched_at) VALUES (?, ?, ?, ?)",
      ).run(VID, "Cached Title", "A", new Date().toISOString());
      const fetchImpl = vi.fn(async () => new Response("{}", { status: 404 }));
      await expect(
        checkAvailable(VID, { fetchImpl: fetchImpl as unknown as typeof fetch }),
      ).resolves.toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── shared handler harness (replace + availability + edit) ───────

type Posted = { path: string; body: unknown };

type HarnessOpts = {
  available?: (videoId: string) => boolean;
  /** Simulate an unreachable account: every direct (DM) post rejects. */
  failDm?: boolean;
  dmError?: Error;
  /** Override title resolution (e.g. to reject a video). */
  resolveTitle?: (videoId: string) => Promise<{
    videoId: string;
    title: string;
    author: string | null;
    canonicalUrl: string;
  }>;
  /** Override finale playlist publishing (default: no link published). */
  publishBattlePlaylist?: BattlePlaylistPublisher;
};

function mockClient(posts: Posted[], deleted: string[], opts: { failDm?: boolean; dmError?: Error } = {}) {
  return {
    get: vi.fn(async () => ({ id: "bot", acct: "playlistbattle" })),
    getWithLink: vi.fn(async () => ({ data: [], linkNext: null })),
    post: vi.fn(async (path: string, body?: unknown) => {
      const b = body as { poll?: unknown; visibility?: string } | undefined;
      if (opts.failDm && b?.visibility === "direct") {
        throw opts.dmError ?? new MastodonApiError(403, { error: "account unreachable" });
      }
      posts.push({ path, body });
      const id = `status-${posts.length}`;
      if (b?.poll) return { id, poll: { id: `poll-${posts.length}`, expires_at: "2026-09-22T12:00:00.000Z" } };
      return { id, visibility: "public" };
    }),
    delete: vi.fn(async (path: string) => {
      deleted.push(path);
      return {};
    }),
    rateLimit: null,
  } as unknown as MastodonClient;
}

function setupHandlerHarness(opts: HarnessOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pb-v11-"));
  const db = openDatabase(join(dir, "test.db"));
  migrate(db);
  const posts: Posted[] = [];
  const deleted: string[] = [];
  const client = mockClient(posts, deleted, opts);
  const available = opts.available ?? (() => true);
  const deps: HandlerDeps = {
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
      local: true,
    })),
    resolveTitle: vi.fn(
      opts.resolveTitle ??
        (async (videoId: string) => ({
          videoId,
          title: `Title for ${videoId}`,
          author: "Artist",
          canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
        })),
    ),
    checkAvailable: vi.fn(async (videoId: string) => available(videoId)),
    publishBattlePlaylist: opts.publishBattlePlaylist ?? vi.fn(async () => null),
    replacementGraceMin: 15,
    now: () => new Date("2026-09-21T12:00:00Z"),
    newGameId: () => `game-${Math.random().toString(36).slice(2, 8)}`,
    log: vi.fn(),
  };
  return { dir, db, posts, deleted, client, deps };
}

async function createAndAccept(deps: HandlerDeps) {
  const res = await handlePublicCommand(
    {
      accountId: "id-host",
      accountAcct: "host",
      statusId: "s-create",
      content: `<p>@playlistbattle newgame "Theme" 8 @alice</p>`,
      inReplyToId: null,
    },
    deps,
  );
  const gameId = (res as { detail: string }).detail;
  for (const [id, acct] of [["id-alice", "alice"]] as const) {
    await handleDm(
      { accountId: id, accountAcct: acct, statusId: `s-acc-${id}`, content: "<p>accept</p>", inReplyToId: null },
      deps,
    );
  }
  return gameId;
}

function dmLink(videoId: string) {
  return `<p>https://www.youtube.com/watch?v=${videoId}</p>`;
}

function makeId(seed: string): string {
  return `${seed}0000000`.slice(0, 11);
}

describe("replace DM (v1.1 1.6) + edit-until-deadline", () => {
  let h: ReturnType<typeof setupHandlerHarness>;
  beforeEach(() => {
    h = setupHandlerHarness();
  });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function submitOne(accountId: string, acct: string, videoId: string) {
    return handleDm(
      { accountId, accountAcct: acct, statusId: `s-${accountId}-${videoId}`, content: dmLink(videoId), inReplyToId: null },
      h.deps,
    );
  }

  it("replace <n> <url> swaps the tune (second submission wins)", async () => {
    await createAndAccept(h.deps);
    const v1 = makeId("aaaaaaaaa01");
    const v2 = makeId("bbbbbbbbb02");
    await submitOne("id-host", "host", v1);
    const r = await handleDm(
      {
        accountId: "id-host",
        accountAcct: "host",
        statusId: "s-replace",
        content: `<p>replace 1 https://youtu.be/${v2}</p>`,
        inReplyToId: null,
      },
      h.deps,
    );
    expect(r).toMatchObject({ handled: true, kind: "tune_replaced" });
    const row = h.db
      .prepare("SELECT video_id FROM tunes WHERE account_id = ? AND position = 1")
      .get("id-host") as { video_id: string };
    expect(row.video_id).toBe(v2);
  });

  it("replace twice → last write wins", async () => {
    await createAndAccept(h.deps);
    const v1 = makeId("aaaaaaaaa01");
    const v2 = makeId("bbbbbbbbb02");
    const v3 = makeId("ccccccccc03");
    await submitOne("id-host", "host", v1);
    await handleDm(
      { accountId: "id-host", accountAcct: "host", statusId: "s-r1", content: `<p>replace 1 https://youtu.be/${v2}</p>`, inReplyToId: null },
      h.deps,
    );
    await handleDm(
      { accountId: "id-host", accountAcct: "host", statusId: "s-r2", content: `<p>replace 1 https://youtu.be/${v3}</p>`, inReplyToId: null },
      h.deps,
    );
    const row = h.db
      .prepare("SELECT video_id FROM tunes WHERE account_id = ? AND position = 1")
      .get("id-host") as { video_id: string };
    expect(row.video_id).toBe(v3);
  });

  it("replace out-of-range → errReplacePosition", async () => {
    await createAndAccept(h.deps);
    const r = await handleDm(
      { accountId: "id-host", accountAcct: "host", statusId: "s-bad", content: `<p>replace 9 https://youtu.be/${makeId("zzzzzzzzz99")}</p>`, inReplyToId: null },
      h.deps,
    );
    expect(r).toMatchObject({ handled: true, kind: "replace_rejected" });
  });

  it("replace missing position → errReplaceMissing", async () => {
    await createAndAccept(h.deps);
    const r = await handleDm(
      { accountId: "id-host", accountAcct: "host", statusId: "s-miss", content: `<p>replace 3 https://youtu.be/${makeId("zzzzzzzzz99")}</p>`, inReplyToId: null },
      h.deps,
    );
    expect(r).toMatchObject({ handled: true, kind: "replace_rejected", detail: "no tune at position" });
  });

  it("replace duplicate video → alreadyInPlaylist", async () => {
    await createAndAccept(h.deps);
    const v1 = makeId("aaaaaaaaa01");
    const v2 = makeId("bbbbbbbbb02");
    await submitOne("id-host", "host", v1);
    await submitOne("id-host", "host", v2);
    const r = await handleDm(
      { accountId: "id-host", accountAcct: "host", statusId: "s-dup", content: `<p>replace 1 https://youtu.be/${v2}</p>`, inReplyToId: null },
      h.deps,
    );
    expect(r).toMatchObject({ handled: true, kind: "replace_rejected", detail: "duplicate" });
  });

  it("replace with no collecting game → not collecting", async () => {
    const r = await handleDm(
      { accountId: "id-ghost", accountAcct: "ghost", statusId: "s-x", content: `<p>replace 1 https://youtu.be/${makeId("zzzzzzzzz99")}</p>`, inReplyToId: null },
      h.deps,
    );
    expect(r).toMatchObject({ handled: true, kind: "replace_rejected", detail: "not collecting" });
  });

  it("replace unplayable URL → not playable", async () => {
    await createAndAccept(h.deps);
    await submitOne("id-host", "host", makeId("aaaaaaaaa01"));
    const r = await handleDm(
      { accountId: "id-host", accountAcct: "host", statusId: "s-unplay", content: `<p>replace 1 https://vimeo.com/123</p>`, inReplyToId: null },
      h.deps,
    );
    expect(r).toMatchObject({ handled: true, kind: "replace_rejected", detail: "not playable" });
  });

  it("rejects a submission after the deadline before the scheduler sweep", async () => {
    const gameId = await createAndAccept(h.deps);
    h.db
      .prepare("UPDATE games SET submission_deadline = ? WHERE id = ?")
      .run("2026-09-20T12:00:00.000Z", gameId);

    const result = await handleDm(
      {
        accountId: "id-host",
        accountAcct: "host",
        statusId: "s-before-sweep",
        content: dmLink(makeId("beforesweep")),
        inReplyToId: null,
      },
      h.deps,
    );

    expect(result).toMatchObject({ handled: true, kind: "no_collecting_game" });
    expect(h.db.prepare("SELECT COUNT(*) AS c FROM tunes").get()).toEqual({ c: 0 });
  });

  it("submission after deadline (game left COLLECTING) is rejected", async () => {
    const gameId = await createAndAccept(h.deps);
    // Force the game out of COLLECTING (deadline path → FIZZLED with no tunes).
    h.db.prepare("UPDATE games SET submission_deadline = ? WHERE id = ?").run("2026-09-20T12:00:00.000Z", gameId);
    await checkDeadlines({ handler: h.deps, now: h.deps.now });
    const g = h.db.prepare("SELECT status FROM games WHERE id = ?").get(gameId) as { status: string };
    expect(g.status).not.toBe("COLLECTING");
    const r = await handleDm(
      { accountId: "id-host", accountAcct: "host", statusId: "s-late", content: dmLink(makeId("late0000001")), inReplyToId: null },
      h.deps,
    );
    expect(r).toMatchObject({ handled: true, kind: "no_collecting_game" });
    expect(h.db.prepare("SELECT COUNT(*) AS c FROM tunes").get()).toEqual({ c: 0 });
  });

  it("resolve failure DMs the catalog copy, never the raw error", async () => {
    const failing = setupHandlerHarness({
      resolveTitle: async () => {
        throw new Error("SQLITE_CONSTRAINT: UNIQUE failed for tunes");
      },
    });
    try {
      await createAndAccept(failing.deps);
      const r = await handleDm(
        {
          accountId: "id-host",
          accountAcct: "host",
          statusId: "s-raw-err",
          content: dmLink(makeId("aaaaaaaaa01")),
          inReplyToId: null,
        },
        failing.deps,
      );

      // the reason stays available to the caller…
      expect(r).toMatchObject({
        handled: true,
        kind: "tune_rejected",
        detail: "SQLITE_CONSTRAINT: UNIQUE failed for tunes",
      });
      // …but the player only ever sees catalog copy
      const dm = failing.posts.map((p) => String((p.body as { status?: string }).status ?? "")).join("\n");
      expect(dm).toContain(m().resolveVideoError());
      expect(dm).not.toContain("SQLITE_CONSTRAINT");
      // …and the internals are still observable to the operator
      expect(failing.deps.log).toHaveBeenCalledWith(
        "tune submission failed",
        expect.objectContaining({ err: "SQLITE_CONSTRAINT: UNIQUE failed for tunes" }),
      );
    } finally {
      failing.db.close();
      rmSync(failing.dir, { recursive: true, force: true });
    }
  });
});

describe("availability window (v1.1 1.4)", () => {
  function seedRoundGame(
    db: Db,
    opts: { players: string[]; deadVideo?: string },
  ): { gameId: string; roundVideo: Map<string, string> } {
    const gameId = `g-${Math.random().toString(36).slice(2, 8)}`;
    const now = "2026-09-21T12:00:00.000Z";
    db.prepare(
      `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec,
        acceptance_deadline, submission_deadline, thread_root_id, current_round, pot, created_at, updated_at)
       VALUES (?, 'ROUND', 'Theme', 8, 'id-host', 86400, ?, ?, 'root-1', 1, 0, ?, ?)`,
    ).run(gameId, now, now, now, now);
    const roundVideo = new Map<string, string>();
    for (const acct of opts.players) {
      const accountId = `id-${acct}`;
      db.prepare(
        `INSERT INTO players (game_id, account_id, acct, role, invite_status, points) VALUES (?, ?, ?, ?, 'accepted', 0)`,
      ).run(gameId, accountId, acct, acct === "host" ? "host" : "challenger");
      const base = acct.replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(8, "0");
      for (let pos = 1; pos <= 8; pos += 1) {
        const vid = `${base}${String(pos).padStart(3, "0")}`.slice(0, 11);
        const videoId = pos === 1 && opts.deadVideo && accountId === opts.deadVideo ? "dead0000001" : vid;
        if (pos === 1) roundVideo.set(accountId, videoId);
        db.prepare(
          `INSERT INTO tunes (game_id, account_id, position, video_id, title, canonical_url) VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(gameId, accountId, pos, videoId, `Title ${videoId}`, `https://www.youtube.com/watch?v=${videoId}`);
      }
    }
    return { gameId, roundVideo };
  }

  let h: ReturnType<typeof setupHandlerHarness>;
  const dead = new Set<string>(["dead0000001"]);
  beforeEach(() => {
    h = setupHandlerHarness({ available: (vid) => !dead.has(vid) });
  });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("dead video → announced row + DM, no poll yet", async () => {
    const { gameId } = seedRoundGame(h.db, { players: ["host", "alice"], deadVideo: "id-alice" });
    await emitRound(h.deps, gameId, 1);
    const round = h.db.prepare("SELECT status FROM rounds WHERE game_id = ? AND number = 1").get(gameId) as {
      status: string;
    };
    expect(round.status).toBe("announced");
    const meta = JSON.parse(
      (h.db.prepare("SELECT option_map_json FROM rounds WHERE game_id = ? AND number = 1").get(gameId) as {
        option_map_json: string;
      }).option_map_json,
    ) as { replacement: { deadline: string; notified: string[] } };
    expect(meta.replacement.notified).toContain("id-alice");
    // DM sent to the affected player
    expect(h.posts.some((p) => String((p.body as { status?: string }).status ?? "").includes("no longer playable"))).toBe(true);
    // No poll opened
    expect(h.db.prepare("SELECT COUNT(*) AS c FROM rounds WHERE game_id = ? AND status = 'poll_open'").get(gameId)).toEqual({ c: 0 });
  });

  it("replacement arrival via plain link publishes the poll", async () => {
    const { gameId } = seedRoundGame(h.db, { players: ["host", "alice"], deadVideo: "id-alice" });
    await emitRound(h.deps, gameId, 1);
    // Player replaces round-1 tune with a healthy video via plain link.
    const fresh = makeId("fresh000001");
    const r = await handleDm(
      { accountId: "id-alice", accountAcct: "alice", statusId: "s-fix", content: dmLink(fresh), inReplyToId: null },
      h.deps,
    );
    expect(r).toMatchObject({ handled: true, kind: "tune_replaced" });
    const round = h.db.prepare("SELECT status FROM rounds WHERE game_id = ? AND number = 1").get(gameId) as {
      status: string;
    };
    expect(round.status).toBe("poll_open");
  });

  it("routes a replacement to the game whose DM notice was replied to", async () => {
    const first = seedRoundGame(h.db, { players: ["host", "alice"], deadVideo: "id-alice" });
    const second = seedRoundGame(h.db, { players: ["host", "alice"], deadVideo: "id-alice" });
    await emitRound(h.deps, first.gameId, 1);
    await emitRound(h.deps, second.gameId, 1);

    const rows = h.db
      .prepare("SELECT game_id, option_map_json FROM rounds WHERE status = 'announced'")
      .all() as { game_id: string; option_map_json: string }[];
    const firstMeta = JSON.parse(rows.find((row) => row.game_id === first.gameId)!.option_map_json) as {
      replacement: { prompts: Record<string, string> };
    };
    const promptId = firstMeta.replacement.prompts["id-alice"]!;
    const fresh = makeId("scoped00001");

    const result = await handleDm(
      {
        accountId: "id-alice",
        accountAcct: "alice",
        statusId: "s-scoped",
        content: dmLink(fresh),
        inReplyToId: promptId,
      },
      h.deps,
    );

    expect(result).toMatchObject({ handled: true, kind: "tune_replaced" });
    const firstRound = h.db
      .prepare("SELECT status FROM rounds WHERE game_id = ? AND number = 1")
      .get(first.gameId) as { status: string };
    const secondRound = h.db
      .prepare("SELECT status FROM rounds WHERE game_id = ? AND number = 1")
      .get(second.gameId) as { status: string };
    expect(firstRound.status).toBe("poll_open");
    expect(secondRound.status).toBe("announced");
  });

  it("deadline with no replacement → round forfeit excludes the player (2 of 3 → 2-option poll)", async () => {
    const { gameId } = seedRoundGame(h.db, { players: ["host", "alice", "bob"], deadVideo: "id-bob" });
    await emitRound(h.deps, gameId, 1);
    // Advance past the replacement grace window, then sweep.
    const late = new Date("2026-09-21T12:00:00Z").getTime() + 16 * 60 * 1000;
    h.deps.now = () => new Date(late);
    await checkDeadlines({ handler: h.deps, now: h.deps.now });
    const round = h.db.prepare("SELECT status, option_map_json FROM rounds WHERE game_id = ? AND number = 1").get(gameId) as {
      status: string;
      option_map_json: string;
    };
    expect(round.status).toBe("poll_open");
    const map = JSON.parse(round.option_map_json) as Record<string, string>;
    expect(Object.values(map)).toHaveLength(2);
    expect(Object.values(map)).not.toContain("id-bob");
  });

  it("single remaining player after exclusion → walkover", async () => {
    const { gameId } = seedRoundGame(h.db, { players: ["host", "alice"], deadVideo: "id-alice" });
    await emitRound(h.deps, gameId, 1);
    const late = new Date("2026-09-21T12:00:00Z").getTime() + 16 * 60 * 1000;
    h.deps.now = () => new Date(late);
    await checkDeadlines({ handler: h.deps, now: h.deps.now });
    const round = h.db.prepare("SELECT status, winner_account_id FROM rounds WHERE game_id = ? AND number = 1").get(gameId) as {
      status: string;
      winner_account_id: string | null;
    };
    expect(round.status).toBe("walkover");
    expect(round.winner_account_id).toBe("id-host");
  });

  it("`replace <n> <url>` replaces the current round's tune during the window", async () => {
    const { gameId } = seedRoundGame(h.db, { players: ["host", "alice"], deadVideo: "id-alice" });
    await emitRound(h.deps, gameId, 1);
    const fresh = makeId("fresh000001");

    const r = await handleDm(
      {
        accountId: "id-alice",
        accountAcct: "alice",
        statusId: "s-repl-window",
        content: `<p>replace 1 https://youtu.be/${fresh}</p>`,
        inReplyToId: null,
      },
      h.deps,
    );

    expect(r).toMatchObject({ handled: true, kind: "tune_replaced" });
    const tune = h.db
      .prepare("SELECT video_id FROM tunes WHERE game_id = ? AND account_id = 'id-alice' AND position = 1")
      .get(gameId) as { video_id: string };
    expect(tune.video_id).toBe(fresh);
    // healthy again → the round publishes
    const round = h.db
      .prepare("SELECT status FROM rounds WHERE game_id = ? AND number = 1")
      .get(gameId) as { status: string };
    expect(round.status).toBe("poll_open");
  });

  it("`replace <n> <url>` targeting another position is rejected while the window is open", async () => {
    const { gameId } = seedRoundGame(h.db, { players: ["host", "alice"], deadVideo: "id-alice" });
    await emitRound(h.deps, gameId, 1);
    const fresh = makeId("fresh000001");

    const r = await handleDm(
      {
        accountId: "id-alice",
        accountAcct: "alice",
        statusId: "s-repl-other",
        content: `<p>replace 2 https://youtu.be/${fresh}</p>`,
        inReplyToId: null,
      },
      h.deps,
    );

    expect(r).toMatchObject({
      handled: true,
      kind: "replace_rejected",
      detail: "position outside the open window",
    });
    const tune = h.db
      .prepare("SELECT video_id FROM tunes WHERE game_id = ? AND account_id = 'id-alice' AND position = 1")
      .get(gameId) as { video_id: string };
    expect(tune.video_id).toBe("dead0000001");
    const dm = h.posts.map((p) => String((p.body as { status?: string }).status ?? "")).join("\n");
    expect(dm).toContain(m().errReplaceWindowOnly(1));
  });

  it("transient replacement DM failure does not forfeit the game", async () => {
    const fd = setupHandlerHarness({
      available: (videoId) => !dead.has(videoId),
      failDm: true,
      dmError: new Error("temporary network failure"),
    });
    try {
      const { gameId } = seedRoundGame(fd.db, { players: ["host", "alice"], deadVideo: "id-alice" });
      await emitRound(fd.deps, gameId, 1);

      const game = fd.db.prepare("SELECT status FROM games WHERE id = ?").get(gameId) as { status: string };
      const round = fd.db
        .prepare("SELECT status FROM rounds WHERE game_id = ? AND number = 1")
        .get(gameId) as { status: string };
      expect(game.status).toBe("ROUND");
      expect(round.status).toBe("announced");
    } finally {
      fd.db.close();
      rmSync(fd.dir, { recursive: true, force: true });
    }
  });

  it("unreachable player during the window → FORFEIT, no round published", async () => {
    const fd = setupHandlerHarness({ available: (videoId) => !dead.has(videoId), failDm: true });
    try {
      const { gameId } = seedRoundGame(fd.db, { players: ["host", "alice"], deadVideo: "id-alice" });
      await emitRound(fd.deps, gameId, 1);

      const game = fd.db.prepare("SELECT status FROM games WHERE id = ?").get(gameId) as { status: string };
      expect(game.status).toBe("FORFEIT");
      // nothing may be published onto the void game — no round row, no poll post
      expect(fd.db.prepare("SELECT status FROM rounds WHERE game_id = ?").all(gameId)).toEqual([]);
      const pollPosts = fd.posts.filter((p) =>
        String((p.body as { status?: string }).status ?? "").includes("Vote for"),
      );
      expect(pollPosts).toHaveLength(0);
    } finally {
      fd.db.close();
      rmSync(fd.dir, { recursive: true, force: true });
    }
  });
});

describe("deletion precedence over walkover (v1.1 1.5)", () => {
  it("2-player game, one account deleted → FORFEIT, no champion", async () => {
    const h = setupHandlerHarness();
    try {
      const gameId = `g-${Math.random().toString(36).slice(2, 8)}`;
      const now = "2026-09-21T12:00:00.000Z";
      h.db.prepare(
        `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec,
          acceptance_deadline, submission_deadline, thread_root_id, current_round, pot, created_at, updated_at)
         VALUES (?, 'ROUND', 'Theme', 8, 'id-host', 86400, ?, ?, 'root-1', 3, 2, ?, ?)`,
      ).run(gameId, now, now, now, now);
      for (const [id, acct, role] of [["id-host", "host", "host"], ["id-alice", "alice", "challenger"]] as const) {
        h.db.prepare(
          `INSERT INTO players (game_id, account_id, acct, role, invite_status, points) VALUES (?, ?, ?, ?, 'accepted', 0)`,
        ).run(gameId, id, acct, role);
        const base = acct.replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(8, "0");
        for (let pos = 1; pos <= 8; pos += 1) {
          const vid = `${base}${String(pos).padStart(3, "0")}`.slice(0, 11);
          h.db.prepare(
            `INSERT INTO tunes (game_id, account_id, position, video_id, title, canonical_url) VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(gameId, id, pos, vid, `T ${vid}`, `https://www.youtube.com/watch?v=${vid}`);
        }
      }
      const affected = await handlePlayerDeleted(h.deps, "id-alice");
      expect(affected).toContain(gameId);
      const g = h.db.prepare("SELECT status, pot FROM games WHERE id = ?").get(gameId) as {
        status: string;
        pot: number;
      };
      expect(g.status).toBe("FORFEIT");
      expect(g.pot).toBe(0);
      // No finale/champion: game never reaches CLOSED with standings.
      expect(g.status).not.toBe("CLOSED");
    } finally {
      h.db.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it("FORFEIT closes a still-open round poll and removes its status", async () => {
    const h = setupHandlerHarness();
    try {
      const gameId = `g-${Math.random().toString(36).slice(2, 8)}`;
      const now = "2026-09-21T12:00:00.000Z";
      h.db.prepare(
        `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec,
          acceptance_deadline, submission_deadline, thread_root_id, current_round, pot, created_at, updated_at)
         VALUES (?, 'ROUND', 'Theme', 8, 'id-host', 86400, ?, ?, 'root-1', 1, 0, ?, ?)`,
      ).run(gameId, now, now, now, now);
      for (const [id, acct, role] of [
        ["id-host", "host", "host"],
        ["id-alice", "alice", "challenger"],
      ] as const) {
        h.db
          .prepare(
            `INSERT INTO players (game_id, account_id, acct, role, invite_status, points) VALUES (?, ?, ?, ?, 'accepted', 0)`,
          )
          .run(gameId, id, acct, role);
      }
      h.db
        .prepare(
          `INSERT INTO rounds (game_id, number, status, poll_status_id, poll_id, poll_expires_at, option_map_json)
           VALUES (?, 1, 'poll_open', 'poll-status-1', 'poll-1', ?, '{"0":"id-host","1":"id-alice"}')`,
        )
        .run(gameId, "2026-09-22T12:00:00.000Z");

      await handlePlayerDeleted(h.deps, "id-alice");

      const round = h.db
        .prepare("SELECT status, poll_status_id FROM rounds WHERE game_id = ? AND number = 1")
        .get(gameId);
      expect(round).toEqual({ status: "resolved", poll_status_id: null });
      expect(h.deleted).toEqual(["/api/v1/statuses/poll-status-1"]);
    } finally {
      h.db.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});

describe("finale champions (PRD \u00a76)", () => {
  it("never crowns a withdrawn player in a scoreless finale", async () => {
    const h = setupHandlerHarness();
    try {
      const gameId = "g-finale";
      const now = "2026-09-21T12:00:00.000Z";
      h.db
        .prepare(
          `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec,
            acceptance_deadline, submission_deadline, thread_root_id, current_round, pot, created_at, updated_at)
           VALUES (?, 'FINALE', 'Solo Act', 8, 'id-host', 86400, ?, ?, 'root-1', 8, 0, ?, ?)`,
        )
        .run(gameId, now, now, now, now);
      for (const [id, acct, role, status] of [
        ["id-host", "host", "host", "accepted"],
        ["id-alice", "alice", "challenger", "declined"],
      ] as const) {
        h.db
          .prepare(
            `INSERT INTO players (game_id, account_id, acct, role, invite_status, points) VALUES (?, ?, ?, ?, ?, 0)`,
          )
          .run(gameId, id, acct, role, status);
      }

      await emitFinale(h.deps, gameId);

      const text = h.posts
        .map((p) => String((p.body as { status?: string }).status ?? ""))
        .join("\n");
      expect(text).toContain(m().champion("@host"));
      expect(text).not.toContain("@alice");
    } finally {
      h.db.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});

describe("finale playlist link (PRD \u00a75.7)", () => {
  /** FINALE game: two accepted players, one tune each, one round won by each. */
  function seedFinale(db: Db): string {
    const gameId = "g-playlist";
    const now = "2026-09-21T12:00:00.000Z";
    db.prepare(
      `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec,
        acceptance_deadline, submission_deadline, thread_root_id, current_round, pot, created_at, updated_at)
       VALUES (?, 'FINALE', 'Road Trip', 8, 'id-host', 86400, ?, ?, 'root-1', 8, 0, ?, ?)`,
    ).run(gameId, now, now, now, now);
    for (const [id, acct, role] of [
      ["id-host", "host", "host"],
      ["id-alice", "alice", "challenger"],
    ] as const) {
      db.prepare(
        `INSERT INTO players (game_id, account_id, acct, role, invite_status, points)
         VALUES (?, ?, ?, ?, 'accepted', 0)`,
      ).run(gameId, id, acct, role);
    }
    for (const [accountId, position, videoId] of [
      ["id-host", 1, "vidA"],
      ["id-alice", 2, "vidB"],
    ] as const) {
      db.prepare(
        `INSERT INTO tunes (game_id, account_id, position, video_id, title, canonical_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(gameId, accountId, position, videoId, `Tune ${videoId}`, `https://www.youtube.com/watch?v=${videoId}`);
    }
    for (const [number, winner] of [
      [1, "id-host"],
      [2, "id-alice"],
    ] as const) {
      db.prepare(
        `INSERT INTO rounds (game_id, number, status, winner_account_id, option_map_json)
         VALUES (?, ?, 'resolved', ?, '{}')`,
      ).run(gameId, number, winner);
    }
    return gameId;
  }

  function playlistIdOf(db: Db, gameId: string): string | null {
    return (db.prepare("SELECT battle_playlist_id AS id FROM games WHERE id = ?").get(gameId) as {
      id: string | null;
    }).id;
  }

  it("publishes the battle link as the first finale reply and records the playlist", async () => {
    const publish = vi.fn(async () => ({
      url: "https://music.youtube.com/playlist?list=PLx",
      playlistId: "PLx",
    }));
    const h = setupHandlerHarness({ publishBattlePlaylist: publish });
    try {
      const gameId = seedFinale(h.db);

      await emitFinale(h.deps, gameId);

      expect(publish).toHaveBeenCalledWith({
        theme: "Road Trip",
        rounds: 8,
        tunes: [
          { round: 1, videoId: "vidA" },
          { round: 2, videoId: "vidB" },
        ],
        existingPlaylistId: null,
      });
      const linkPost = h.posts[1]!.body as { status: string; in_reply_to_id: string };
      expect(linkPost.in_reply_to_id).toBe("status-1");
      expect(linkPost.status).toContain("https://music.youtube.com/playlist?list=PLx");
      expect(playlistIdOf(h.db, gameId)).toBe("PLx");
    } finally {
      h.db.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it("reuses the recorded playlist when a finale is emitted again", async () => {
    const publish = vi.fn(async (input: { existingPlaylistId: string | null }) => ({
      url: `https://music.youtube.com/playlist?list=${input.existingPlaylistId}`,
      playlistId: input.existingPlaylistId,
    }));
    const h = setupHandlerHarness({ publishBattlePlaylist: publish });
    try {
      const gameId = seedFinale(h.db);
      h.db.prepare("UPDATE games SET battle_playlist_id = 'PLrecorded' WHERE id = ?").run(gameId);

      await emitFinale(h.deps, gameId);

      expect(publish).toHaveBeenCalledWith(expect.objectContaining({ existingPlaylistId: "PLrecorded" }));
      expect((h.posts[1]!.body as { status: string }).status).toContain("list=PLrecorded");
      expect(playlistIdOf(h.db, gameId)).toBe("PLrecorded");
    } finally {
      h.db.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it("posts the finale without a link when nothing could be published", async () => {
    const h = setupHandlerHarness();
    try {
      const gameId = seedFinale(h.db);

      await emitFinale(h.deps, gameId);

      // summary + one post per winning tune, and no link reply in between
      expect(h.posts).toHaveLength(3);
      expect((h.posts[1]!.body as { status: string }).status).toMatch(/Round 1/);
      expect(playlistIdOf(h.db, gameId)).toBeNull();
    } finally {
      h.db.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});

describe("cancel command (RULES \u00a74/\u00a76)", () => {
  /** ROUND game, round 1 poll open, host + one challenger. */
  function seedOpenGame(db: Db, pollStatusId = "poll-status-1"): string {
    const gameId = "g-cancel";
    const now = "2026-09-21T12:00:00.000Z";
    db.prepare(
      `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec,
        acceptance_deadline, submission_deadline, thread_root_id, current_round, pot, created_at, updated_at)
       VALUES (?, 'ROUND', 'Road Trip', 8, 'id-host', 86400, ?, ?, 'root-1', 1, 0, ?, ?)`,
    ).run(gameId, now, now, now, now);
    for (const [id, acct, role] of [
      ["id-host", "host", "host"],
      ["id-alice", "alice", "challenger"],
    ] as const) {
      db.prepare(
        `INSERT INTO players (game_id, account_id, acct, role, invite_status, points) VALUES (?, ?, ?, ?, 'accepted', 0)`,
      ).run(gameId, id, acct, role);
    }
    db.prepare(
      `INSERT INTO rounds (game_id, number, status, poll_status_id, poll_id, poll_expires_at, option_map_json)
       VALUES (?, 1, 'poll_open', ?, 'poll-1', ?, '{"0":"id-host","1":"id-alice"}')`,
    ).run(gameId, pollStatusId, "2026-09-22T12:00:00.000Z");
    return gameId;
  }

  function dm(input: { accountId: string; accountAcct: string; content: string }) {
    return { statusId: `s-${input.content}`, inReplyToId: null, ...input };
  }

  it("host cancels mid-round → CANCELLED, poll closed, no champion, notice posted", async () => {
    const h = setupHandlerHarness();
    try {
      const gameId = seedOpenGame(h.db);

      const r = await handleDm(dm({ accountId: "id-host", accountAcct: "host", content: "<p>cancel</p>" }), h.deps);

      expect(r).toMatchObject({ handled: true, kind: "game_cancelled", detail: gameId });
      const game = h.db.prepare("SELECT status FROM games WHERE id = ?").get(gameId) as { status: string };
      expect(game.status).toBe("CANCELLED");
      // the live poll is closed and removed — votes cannot land on a void game
      expect(
        h.db.prepare("SELECT status, poll_status_id FROM rounds WHERE game_id = ? AND number = 1").get(gameId),
      ).toEqual({ status: "resolved", poll_status_id: null });
      expect(h.deleted).toEqual(["/api/v1/statuses/poll-status-1"]);
      const posted = h.posts.map((p) => String((p.body as { status?: string }).status ?? ""));
      expect(posted).toContain(m().sideCancelled("Road Trip"));
      expect(posted.join("\n")).toContain(m().cancelDone("Road Trip"));
    } finally {
      h.db.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it("a challenger cannot cancel the host's game", async () => {
    const h = setupHandlerHarness();
    try {
      const gameId = seedOpenGame(h.db);

      const r = await handleDm(dm({ accountId: "id-alice", accountAcct: "alice", content: "<p>cancel</p>" }), h.deps);

      expect(r).toMatchObject({ handled: true, kind: "cancel_rejected" });
      const game = h.db.prepare("SELECT status FROM games WHERE id = ?").get(gameId) as { status: string };
      expect(game.status).toBe("ROUND");
      expect(h.deleted).toEqual([]);
    } finally {
      h.db.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });

  it("nothing to cancel → rejected with guidance", async () => {
    const h = setupHandlerHarness();
    try {
      const r = await handleDm(dm({ accountId: "id-host", accountAcct: "host", content: "<p>cancel</p>" }), h.deps);

      expect(r).toMatchObject({ handled: true, kind: "cancel_rejected" });
      const posted = h.posts.map((p) => String((p.body as { status?: string }).status ?? "")).join("\n");
      expect(posted).toContain(m().cancelNothing());
    } finally {
      h.db.close();
      rmSync(h.dir, { recursive: true, force: true });
    }
  });
});
