import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, migrate, type Db } from "../src/db/index.js";
import {
  checkDeadlines,
  checkPolls,
  resumeOpenGames,
  type SchedulerDeps,
} from "../src/scheduler/index.js";
import { processNotification, type HandlerDeps } from "../src/handlers/mention.js";
import { handlePlayerDeleted } from "../src/handlers/closure.js";
import { readCursor, writeCursor } from "../src/db/cursor.js";
import { advance, type RawNotification } from "../src/mastodon/notifications.js";
import { checkPollNotification } from "../src/scheduler/index.js";
import { initializeNotificationCursor, pollNotifications } from "../src/mastodon/poller.js";
import { RateLimitError, type MastodonClient } from "../src/mastodon/client.js";

type Posted = { path: string; body: Record<string, unknown> };

function schedDepsOf(handler: HandlerDeps): import("../src/scheduler/index.js").SchedulerDeps {
  return { handler, now: handler.now };
}

function seedGame(
  db: Db,
  opts: {
    id?: string;
    status?: string;
    theme?: string;
    length?: number;
    acceptanceDeadline?: string | null;
    submissionDeadline?: string | null;
    currentRound?: number;
    pot?: number;
    threadRootId?: string;
  } = {},
): string {
  const id = opts.id ?? `g-${Math.random().toString(36).slice(2, 8)}`;
  const now = "2026-09-21T12:00:00.000Z";
  db.prepare(
    `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec,
      acceptance_deadline, submission_deadline, thread_root_id, current_round, pot, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'host1', 86400, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.status ?? "INVITED",
    opts.theme ?? "Test Theme",
    opts.length ?? 8,
    opts.acceptanceDeadline ?? now,
    opts.submissionDeadline ?? null,
    opts.threadRootId ?? "root-1",
    opts.currentRound ?? 0,
    opts.pot ?? 0,
    now,
    now,
  );
  return id;
}

function seedPlayer(
  db: Db,
  gameId: string,
  accountId: string,
  invite = "accepted",
  points = 0,
  role: "host" | "challenger" = "challenger",
): void {
  db.prepare(
    `INSERT INTO players (game_id, account_id, acct, role, invite_status, points) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(gameId, accountId, accountId, role, invite, points);
}

function seedTune(db: Db, gameId: string, accountId: string, position: number, videoId: string): void {
  db.prepare(
    `INSERT INTO tunes (game_id, account_id, position, video_id, title, canonical_url) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(gameId, accountId, position, videoId, `Title ${videoId}`, `https://www.youtube.com/watch?v=${videoId}`);
}

function seedPollRound(db: Db, gameId: string, round: number, expiresAt: string): void {
  db.prepare(
    `INSERT INTO rounds (game_id, number, status, poll_status_id, poll_id, poll_expires_at, option_map_json)
     VALUES (?, ?, 'poll_open', 'poll-status', ?, ?, ?)`,
  ).run(gameId, round, `pollid-${round}`, expiresAt, JSON.stringify({ "0": "host1", "1": "alice" }));
}

describe("Phase 7 — edge cases + resilience", () => {
  let dir: string;
  let db: Db;
  let posts: Posted[];
  let deps: HandlerDeps & { client: MastodonClient };
  let schedDeps: SchedulerDeps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pb-resil-"));
    db = openDatabase(join(dir, "test.db"));
    migrate(db);
    posts = [];
    const client = {
      post: vi.fn(async (_p: string, body?: unknown) => {
        posts.push({ path: "/api/v1/statuses", body: body as Record<string, unknown> });
        const b = body as { poll?: unknown };
        if (b?.poll) {
          return { id: `s-${posts.length}`, poll: { id: `poll-${posts.length}`, expires_at: "2026-09-22T12:00:00Z" } };
        }
        return { id: `s-${posts.length}` };
      }),
      get: vi.fn(async () => ({
        expired: true,
        options: [
          { title: "host1: A", votes_count: 5 },
          { title: "alice: B", votes_count: 3 },
        ],
      })),
      rateLimit: null,
    } as unknown as MastodonClient;

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
        acct,
        username: acct,
        local: true,
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
      now: () => new Date("2026-09-21T12:00:00.000Z"),
      newGameId: () => "x",
    };
    deps.onPollExpired = async (statusId) => {
      await checkPollNotification(schedDepsOf(deps), statusId);
    };
    schedDeps = schedDepsOf(deps);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("creation post failure → retry never duplicates the game (reorder-only fix)", () => {
    function createMention(id: string, content: string, statusId: string): RawNotification {
      return {
        id,
        type: "mention",
        created_at: "2026-09-21T12:00:00.000Z",
        account: { id: "id-host", acct: "host", username: "host" },
        status: {
          id: statusId,
          visibility: "public",
          in_reply_to_id: null,
          content,
          mentions: [{ id: "bot-1", username: "playlistbattle", acct: "playlistbattle" }],
        },
      };
    }

    it("persists a creation before invite effects and resumes it without duplicates", async () => {
      let call = 0;
      (deps.client.post as ReturnType<typeof vi.fn>).mockImplementation(
        async (path: string, body?: unknown) => {
          call += 1;
          if (call === 2) throw new Error("DM send failed");
          posts.push({ path, body: body as Record<string, unknown> });
          return { id: `s-${posts.length}` };
        },
      );

      const n = createMention("700", "<p>@playlistbattle newgame \"X\" 8 @alice @bob</p>", "s700");
      (deps.client.get as ReturnType<typeof vi.fn>).mockResolvedValue([n]);
      await expect(pollNotifications(deps)).rejects.toThrow(/DM send failed/);
      const partial = db.prepare("SELECT status FROM games").get() as { status: string };
      expect(partial.status).toBe("CREATED");

      (deps.client.post as ReturnType<typeof vi.fn>).mockImplementation(
        async (path: string, body?: unknown) => {
          posts.push({ path, body: body as Record<string, unknown> });
          return { id: `s-${posts.length}` };
        },
      );
      (deps.client.get as ReturnType<typeof vi.fn>).mockResolvedValue([n]);
      await pollNotifications(deps);

      const games = db.prepare("SELECT COUNT(*) AS c FROM games").get() as { c: number };
      expect(games.c).toBe(1);
      const players = db.prepare("SELECT COUNT(*) AS c FROM players").get() as { c: number };
      expect(players.c).toBe(3);
      const rootPosts = posts.filter(
        (p) => (p.body as { in_reply_to_id?: string }).in_reply_to_id === "s700",
      );
      expect(rootPosts).toHaveLength(1);
      const game = db.prepare("SELECT status, thread_root_id FROM games").get() as {
        status: string;
        thread_root_id: string;
      };
      expect(game.status).toBe("INVITED");
      expect(game.thread_root_id).toBeTruthy();
    });

    it("persistent post failure exhausts retries then marks the notification poison", async () => {
      (deps.client.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("HTTP 500"));
      const n = createMention("801", "<p>@playlistbattle newgame \"X\" 8 @alice</p>", "s801");
      (deps.client.get as ReturnType<typeof vi.fn>).mockResolvedValue([n]);

      for (let i = 1; i <= 3; i++) {
        // attempts 1–2 release the claim and rethrow (retry);
        // attempt 3 marks the notification poison and resolves.
        if (i < 3) {
          await expect(pollNotifications(deps)).rejects.toThrow(/HTTP 500/);
        } else {
          await expect(pollNotifications(deps)).resolves.toBeUndefined();
        }
      }
      // exactly 3 failed attempts consumed — no throw, no claim left pending
      const row = db
        .prepare("SELECT attempts, processed_at FROM processed_notifications WHERE notification_id = '801'")
        .get() as { attempts: number; processed_at: string } | undefined;
      expect(row?.processed_at).toBe("error");

      // poison is terminal: re-polling is a no-op with no retries
      await pollNotifications(deps);
      expect(db.prepare("SELECT attempts FROM processed_notifications WHERE notification_id = '801'").get())
        .toEqual({ attempts: 3 });
      expect(deps.client.post).toHaveBeenCalledTimes(3);

      // an earlier poison does not block later notifications in the same page
      posts.length = 0;
      (deps.client.post as ReturnType<typeof vi.fn>).mockImplementation(
        async (path: string, body?: unknown) => {
          posts.push({ path, body: body as Record<string, unknown> });
          return { id: `s-${posts.length}` };
        },
      );
      const list = [
        n,
        createMention("802", "<p>@playlistbattle status</p>", "s802"),
      ];
      (deps.client.get as ReturnType<typeof vi.fn>).mockResolvedValue(list);
      await pollNotifications(deps);
      expect(posts.length).toBeGreaterThanOrEqual(1); // the later mention was handled
      expect(readCursor(db).lastId).toBe("802"); // cursor advanced past the poison
    });
  });

  describe("incomplete playlist (m < N) — v1.1 full commitment withdraw", () => {
    it("finalize with 2 complete + 1 partial → READY; partial player withdraws, excluded from round 1", async () => {
      const id = seedGame(db, {
        status: "COLLECTING",
        submissionDeadline: "2026-09-21T11:00:00.000Z",
        length: 8,
      });
      seedPlayer(db, id, "host1", "accepted", 0, "host");
      seedPlayer(db, id, "alice", "accepted");
      seedPlayer(db, id, "bob", "accepted");
      for (let i = 1; i <= 8; i++) {
        seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
        seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);
      }
      // bob only submitted 5 of 8 → treated as non-submitter (withdrawal)
      for (let i = 1; i <= 5; i++) seedTune(db, id, "bob", i, `bobbbb0${i}`);

      await checkDeadlines(schedDeps);

      const g = db.prepare("SELECT status, current_round FROM games WHERE id = ?").get(id) as {
        status: string;
        current_round: number;
      };
      expect(g.status).toBe("ROUND");
      expect(g.current_round).toBe(1);

      const bob = db
        .prepare("SELECT invite_status FROM players WHERE game_id = ? AND account_id = ?")
        .get(id, "bob") as { invite_status: string };
      expect(bob.invite_status).toBe("declined");

      // Round 1 poll excludes bob (withdrawn under full commitment)
      const r1 = db.prepare("SELECT option_map_json FROM rounds WHERE game_id = ? AND number = 1").get(id) as {
        option_map_json: string;
      };
      const map = JSON.parse(r1.option_map_json) as Record<string, string>;
      expect(Object.values(map)).toEqual(expect.arrayContaining(["host1", "alice"]));
      expect(Object.values(map)).not.toContain("bob");
    });
  });

  describe("player deleted / unreachable → FORFEIT closure", () => {
    it("marks all open games for the player FORFEIT and posts closure notice", async () => {
      const id = seedGame(db, { status: "ROUND", currentRound: 2, length: 8, threadRootId: "root-1" });
      seedPlayer(db, id, "host1", "accepted", 0, "host");
      seedPlayer(db, id, "alice", "accepted", 4);
      seedPollRound(db, id, 2, "2026-09-21T11:00:00.000Z");

      const affected = await handlePlayerDeleted(deps, "alice");

      expect(affected).toContain(id);
      const g = db.prepare("SELECT status FROM games WHERE id = ?").get(id) as { status: string };
      expect(g.status).toBe("FORFEIT");
      expect(posts.length).toBeGreaterThanOrEqual(1);
      const body = posts[0]!.body as { status: string; in_reply_to_id: string };
      expect(body.in_reply_to_id).toBe("root-1");
      expect(body.status).toMatch(/forfeit|deleted|closed/i);

      // closed games no longer swept by scheduler
      posts.length = 0;
      await checkPolls(schedDeps);
      expect(deps.client.get).not.toHaveBeenCalled();
    });

    it("does not touch games the deleted player is not in", async () => {
      const other = seedGame(db, { status: "ROUND", currentRound: 1, length: 8 });
      seedPlayer(db, other, "host1", "accepted", 0, "host");
      seedPlayer(db, other, "bob", "accepted");
      seedPollRound(db, other, 1, "2026-09-21T11:00:00.000Z");

      const affected = await handlePlayerDeleted(deps, "id-ghost");
      expect(affected).toEqual([]);
      const g = db.prepare("SELECT status FROM games WHERE id = ?").get(other) as { status: string };
      expect(g.status).toBe("ROUND");
    });
  });

  describe("concurrent games + cross-game isolation", () => {
    it("player can be in multiple open games; resolving one does not touch the other", async () => {
      const g1 = seedGame(db, { id: "game-A", status: "ROUND", currentRound: 1, pot: 2, length: 8, theme: "A" });
      const g2 = seedGame(db, { id: "game-B", status: "ROUND", currentRound: 1, pot: 0, length: 8, theme: "B" });
      seedPlayer(db, g1, "host1", "accepted", 10, "host");
      seedPlayer(db, g1, "alice", "accepted", 3);
      seedPlayer(db, g2, "host1", "accepted", 7, "host");
      seedPlayer(db, g2, "alice", "accepted", 2);
      seedPollRound(db, g1, 1, "2026-09-21T11:00:00.000Z");
      // g2 has a future poll — must stay untouched
      seedPollRound(db, g2, 1, "2026-09-22T12:00:00.000Z");
      for (let i = 1; i <= 8; i++) {
        seedTune(db, g1, "host1", i, `ah${String(i).padStart(9, "0")}`);
        seedTune(db, g1, "alice", i, `aa${String(i).padStart(9, "0")}`);
        seedTune(db, g2, "host1", i, `bh${String(i).padStart(9, "0")}`);
        seedTune(db, g2, "alice", i, `ba${String(i).padStart(9, "0")}`);
      }

      await checkPolls(schedDeps);

      const a = db.prepare("SELECT status, current_round, pot FROM games WHERE id = 'game-A'").get() as {
        status: string;
        current_round: number;
        pot: number;
      };
      const b = db.prepare("SELECT status, current_round, pot FROM games WHERE id = 'game-B'").get() as {
        status: string;
        current_round: number;
        pot: number;
      };
      expect(a.current_round).toBe(2);
      expect(a.pot).toBe(0); // winner took pot in A
      expect(b.current_round).toBe(1); // B untouched
      expect(b.pot).toBe(0);
      expect(b.status).toBe("ROUND");

      const aHost = db
        .prepare("SELECT points FROM players WHERE game_id = 'game-A' AND account_id = 'host1'")
        .get() as { points: number };
      const bHost = db
        .prepare("SELECT points FROM players WHERE game_id = 'game-B' AND account_id = 'host1'")
        .get() as { points: number };
      expect(aHost.points).toBe(10 + 5 + 2); // prior + votes + pot
      expect(bHost.points).toBe(7); // B unchanged
    });
  });

  describe("crash-safe cursor advance", () => {
    function mentionNotification(id: string, content: string, statusId: string): RawNotification {
      return {
        id,
        type: "mention",
        created_at: "2026-09-21T12:00:00.000Z",
        account: { id: "id-host", acct: "host", username: "host" },
        status: {
          id: statusId,
          visibility: "public",
          in_reply_to_id: null,
          content,
          mentions: [{ id: "bot-1", username: "playlistbattle", acct: "playlistbattle" }],
        },
      };
    }

    it("does not advance cursor or mark processed when handler throws; retries succeed next poll", async () => {
      const list = [mentionNotification("101", "<p>@playlistbattle status</p>", "s1")];
      (deps.client.get as ReturnType<typeof vi.fn>).mockImplementation(async () => list);
      (deps.client.post as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network blip"));

      await expect(pollNotifications(deps)).rejects.toThrow(/network blip/);

      // cursor frozen at empty; notification NOT marked processed
      expect(readCursor(db).lastId).toBe("");
      const processed = db.prepare("SELECT COUNT(*) AS c FROM processed_notifications").get() as { c: number };
      expect(processed.c).toBe(0);

      // heal and re-poll — same notification re-fetched (since_id still empty)
      (deps.client.post as ReturnType<typeof vi.fn>).mockImplementation(
        async (path: string, body?: unknown) => {
          posts.push({ path, body: body as Record<string, unknown> });
          return { id: "s-ok" };
        },
      );
      await pollNotifications(deps);

      expect(readCursor(db).lastId).toBe("101");
      const after = db.prepare("SELECT COUNT(*) AS c FROM processed_notifications").get() as { c: number };
      expect(after.c).toBe(1);
      // only one successful reply
      const replies = posts.filter((p) => p.path === "/api/v1/statuses");
      expect(replies.length).toBeGreaterThanOrEqual(1);
    });

    it("advance never moves cursor backwards", () => {
      expect(advance("50", { lastId: "100" }).lastId).toBe("100");
      expect(advance("200", { lastId: "100" }).lastId).toBe("200");
      expect(advance("200", { lastId: "" }).lastId).toBe("200");
    });

    it("processes every notification page before finishing a poll", async () => {
      const newer = mentionNotification("702", "<p>@playlistbattle status</p>", "s702");
      const older = mentionNotification("701", "<p>@playlistbattle status</p>", "s701");
      const pagedClient = {
        get: vi.fn(async () => []),
        getWithLink: vi.fn(async (path: string) =>
          path.includes("page=2")
            ? { data: [older], linkNext: null }
            : { data: [newer], linkNext: "page=2" },
        ),
        post: deps.client.post,
        rateLimit: null,
      } as unknown as MastodonClient;
      const pagedDeps = { ...deps, client: pagedClient };

      await pollNotifications(pagedDeps);

      expect(pagedClient.getWithLink).toHaveBeenCalledTimes(2);
      expect(readCursor(db).lastId).toBe("702");
      expect(
        db.prepare("SELECT COUNT(*) AS c FROM processed_notifications").get(),
      ).toEqual({ c: 2 });
    });

    it("does not advance the cursor when a later notification page fails", async () => {
      const newer = mentionNotification("712", "<p>@playlistbattle status</p>", "s712");
      const older = mentionNotification("711", "<p>@playlistbattle status</p>", "s711");
      let postCalls = 0;
      const pagedClient = {
        get: vi.fn(async () => []),
        getWithLink: vi.fn(async (path: string) =>
          path.includes("page=2")
            ? { data: [older], linkNext: null }
            : { data: [newer], linkNext: "page=2" },
        ),
        post: vi.fn(async () => {
          postCalls += 1;
          if (postCalls === 2) throw new Error("page-two failure");
          return { id: `s-${postCalls}` };
        }),
        rateLimit: null,
      } as unknown as MastodonClient;

      await expect(
        pollNotifications({ ...deps, client: pagedClient }),
      ).rejects.toThrow(/page-two failure/);
      expect(readCursor(db).lastId).toBe("");
    });

    it("initializes a first-boot cursor without processing historical notifications", async () => {
      const historical = mentionNotification("800", "<p>@playlistbattle status</p>", "s800");
      const client = {
        get: vi.fn(async () => []),
        getWithLink: vi.fn(async () => ({ data: [historical], linkNext: null })),
        post: deps.client.post,
        rateLimit: null,
      } as unknown as MastodonClient;

      await initializeNotificationCursor({ db, client });

      expect(readCursor(db).lastId).toBe("800");
      expect(
        db.prepare("SELECT COUNT(*) AS c FROM processed_notifications").get(),
      ).toEqual({ c: 0 });
    });

    it("poll_expired notification triggers immediate round resolution", async () => {
      const id = seedGame(db, { status: "ROUND", currentRound: 1, pot: 1, length: 8 });
      seedPlayer(db, id, "host1", "accepted", 0, "host");
      seedPlayer(db, id, "alice", "accepted", 0);
      seedPollRound(db, id, 1, "2026-09-21T11:00:00.000Z");
      for (let i = 1; i <= 8; i++) {
        seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
        seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);
      }

      const n: RawNotification = {
        id: "500",
        type: "poll",
        created_at: "2026-09-21T12:00:00.000Z",
        account: { id: "bot-1", acct: "playlistbattle", username: "playlistbattle" },
        status: { id: "poll-status", visibility: "public", in_reply_to_id: null, content: "", mentions: [] },
      };
      await processNotification(n, deps);

      const g = db.prepare("SELECT current_round, pot FROM games WHERE id = ?").get(id) as {
        current_round: number;
        pot: number;
      };
      expect(g.current_round).toBe(2);
      expect(g.pot).toBe(0);
      const processed = db
        .prepare("SELECT 1 FROM processed_notifications WHERE notification_id = '500'")
        .get();
      expect(processed).toBeDefined();
    });

    it("dedupes: processing the same notification twice is a no-op", async () => {
      const id = seedGame(db, { status: "ROUND", currentRound: 1, pot: 1, length: 8 });
      seedPlayer(db, id, "host1", "accepted", 0, "host");
      seedPlayer(db, id, "alice", "accepted", 0);
      seedPollRound(db, id, 1, "2026-09-21T11:00:00.000Z");
      for (let i = 1; i <= 8; i++) {
        seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
        seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);
      }

      const n: RawNotification = {
        id: "501",
        type: "poll",
        created_at: "2026-09-21T12:00:00.000Z",
        account: { id: "bot-1", acct: "playlistbattle", username: "playlistbattle" },
        status: { id: "poll-status", visibility: "public", in_reply_to_id: null, content: "", mentions: [] },
      };
      await processNotification(n, deps);
      const postsAfterFirst = posts.length;
      await processNotification(n, deps); // deduped
      expect(posts.length).toBe(postsAfterFirst);

      const g = db.prepare("SELECT current_round FROM games WHERE id = ?").get(id) as { current_round: number };
      expect(g.current_round).toBe(2); // not double-advanced
    });

    it("does not dead-letter a notification after repeated rate limits", async () => {
      const n = mentionNotification("602", "<p>@playlistbattle status</p>", "s602");
      (deps.client.post as ReturnType<typeof vi.fn>).mockRejectedValue(
        new RateLimitError(Math.floor(Date.now() / 1000) + 300),
      );

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(processNotification(n, deps)).rejects.toBeInstanceOf(RateLimitError);
      }

      const failure = db
        .prepare(
          `SELECT attempts, dead_lettered_at FROM notification_failures WHERE notification_id = ?`,
        )
        .get(n.id) as { attempts: number; dead_lettered_at: string | null };
      expect(failure.attempts).toBe(1);
      expect(failure.dead_lettered_at).toBeNull();
      (deps.client.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("HTTP 500"));
      await expect(processNotification(n, deps)).rejects.toThrow(/HTTP 500/);
      expect(
        db.prepare("SELECT dead_lettered_at FROM notification_failures WHERE notification_id = ?").get(n.id),
      ).toMatchObject({ dead_lettered_at: null });
      expect(
        db.prepare("SELECT 1 FROM processed_notifications WHERE notification_id = ?").get(n.id),
      ).toBeUndefined();
    });

    it("overlapping deliveries of one notification produce exactly one side effect", async () => {
      const n = mentionNotification("601", "<p>@playlistbattle status</p>", "s1");

      await Promise.all([processNotification(n, deps), processNotification(n, deps)]);

      const replies = posts.filter((p) => p.path === "/api/v1/statuses");
      expect(replies).toHaveLength(1); // second delivery claimed by the first

      const row = db
        .prepare("SELECT processed_at FROM processed_notifications WHERE notification_id = '601'")
        .get() as { processed_at: string } | undefined;
      expect(row?.processed_at).toBe("2026-09-21T12:00:00.000Z"); // completed, not left claimed
    });
  });

  describe("restart-resume / chaos: kill at each state, verify completion", () => {
    it("resume from INVITED past deadline with zero accepts → EXPIRED", async () => {
      const id = seedGame(db, {
        status: "INVITED",
        acceptanceDeadline: "2026-09-21T11:00:00.000Z",
      });
      seedPlayer(db, id, "host1", "accepted", 0, "host");
      seedPlayer(db, id, "alice", "pending");

      await resumeOpenGames(schedDeps);

      const g = db.prepare("SELECT status FROM games WHERE id = ?").get(id) as { status: string };
      expect(g.status).toBe("EXPIRED");
      expect(posts.some((p) => /expired/i.test(String((p.body as { status: string }).status)))).toBe(true);
    });

    it("resume from COLLECTING past submission deadline → round 1 poll open", async () => {
      const id = seedGame(db, {
        status: "COLLECTING",
        submissionDeadline: "2026-09-21T11:00:00.000Z",
        length: 8,
      });
      seedPlayer(db, id, "host1", "accepted", 0, "host");
      seedPlayer(db, id, "alice", "accepted");
      for (let i = 1; i <= 8; i++) {
        seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
        seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);
      }

      await resumeOpenGames(schedDeps);

      const g = db.prepare("SELECT status, current_round FROM games WHERE id = ?").get(id) as {
        status: string;
        current_round: number;
      };
      expect(g.status).toBe("ROUND");
      expect(g.current_round).toBe(1);
      const r1 = db.prepare("SELECT status FROM rounds WHERE game_id = ? AND number = 1").get(id) as {
        status: string;
      };
      expect(r1.status).toBe("poll_open");
    });

    it("resume from READY (crash before round 1 emit) → starts round 1", async () => {
      const id = seedGame(db, { status: "READY", currentRound: 0, length: 8 });
      seedPlayer(db, id, "host1", "accepted", 0, "host");
      seedPlayer(db, id, "alice", "accepted");
      for (let i = 1; i <= 8; i++) {
        seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
        seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);
      }

      await resumeOpenGames(schedDeps);

      const g = db.prepare("SELECT status, current_round FROM games WHERE id = ?").get(id) as {
        status: string;
        current_round: number;
      };
      expect(g.status).toBe("ROUND");
      expect(g.current_round).toBe(1);
      const r1 = db.prepare("SELECT status FROM rounds WHERE game_id = ? AND number = 1").get(id) as
        | { status: string }
        | undefined;
      expect(r1?.status).toBe("poll_open");
    });

    it("resume from ROUND with expired poll mid-game → tallies and advances", async () => {
      const id = seedGame(db, { status: "ROUND", currentRound: 3, pot: 4, length: 8 });
      seedPlayer(db, id, "host1", "accepted", 6, "host");
      seedPlayer(db, id, "alice", "accepted", 5);
      seedPollRound(db, id, 3, "2026-09-21T11:00:00.000Z");
      for (let i = 1; i <= 8; i++) {
        seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
        seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);
      }

      await resumeOpenGames(schedDeps);

      const g = db.prepare("SELECT status, current_round, pot FROM games WHERE id = ?").get(id) as {
        status: string;
        current_round: number;
        pot: number;
      };
      expect(g.status).toBe("ROUND");
      expect(g.current_round).toBe(4);
      expect(g.pot).toBe(0);
      const r3 = db.prepare("SELECT status FROM rounds WHERE game_id = ? AND number = 3").get(id) as {
        status: string;
      };
      expect(r3.status).toBe("resolved");
    });

    it("resume from FINALE (crash before close) → posts finale and closes", async () => {
      const id = seedGame(db, { status: "FINALE", currentRound: 8, pot: 0, length: 8 });
      seedPlayer(db, id, "host1", "accepted", 12, "host");
      seedPlayer(db, id, "alice", "accepted", 9);
      for (let i = 1; i <= 8; i++) {
        seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
        seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);
        db.prepare(
          `INSERT INTO rounds (game_id, number, status, winner_account_id, option_map_json) VALUES (?, ?, 'resolved', ?, '{}')`,
        ).run(id, i, "host1");
      }

      await resumeOpenGames(schedDeps);

      const g = db.prepare("SELECT status FROM games WHERE id = ?").get(id) as { status: string };
      expect(g.status).toBe("CLOSED");
      const rootPosts = posts.filter((p) => !(p.body as { in_reply_to_id?: string }).in_reply_to_id);
      expect(rootPosts.length).toBeGreaterThanOrEqual(1);
      expect(String((rootPosts.at(-1)!.body as { status: string }).status)).toMatch(/Champion|🏆/i);
    });

    it("recovers a persisted CREATED game and completes its creation effects", async () => {
      const id = seedGame(db, {
        id: "created-recovery",
        status: "CREATED",
        acceptanceDeadline: "2026-09-22T12:00:00.000Z",
      });
      db.prepare(
        "UPDATE games SET creation_status_id = ?, creation_visibility = 'public', thread_root_id = NULL WHERE id = ?",
      ).run("s-create-recovery", id);
      seedPlayer(db, id, "host1", "accepted", 0, "host");
      seedPlayer(db, id, "alice", "pending");

      await resumeOpenGames(schedDeps);

      const game = db
        .prepare("SELECT status, thread_root_id FROM games WHERE id = ?")
        .get(id) as { status: string; thread_root_id: string | null };
      expect(game.status).toBe("INVITED");
      expect(game.thread_root_id).toBeTruthy();
      expect(posts.some((p) => (p.body as { visibility?: string }).visibility === "direct")).toBe(true);
    });

    it("does not withdraw partial submissions when restart happens before the deadline", async () => {
      const id = seedGame(db, {
        id: "future-collecting",
        status: "COLLECTING",
        acceptanceDeadline: "2026-09-22T12:00:00.000Z",
        submissionDeadline: "2026-09-23T12:00:00.000Z",
        length: 8,
      });
      seedPlayer(db, id, "host1", "accepted", 0, "host");
      seedPlayer(db, id, "alice", "accepted");
      for (let i = 1; i <= 3; i++) {
        seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
      }

      await resumeOpenGames(schedDeps);

      const host = db
        .prepare("SELECT invite_status FROM players WHERE game_id = ? AND account_id = 'host1'")
        .get(id) as { invite_status: string };
      const game = db
        .prepare("SELECT status FROM games WHERE id = ?")
        .get(id) as { status: string };
      expect(host.invite_status).toBe("accepted");
      expect(game.status).toBe("COLLECTING");
    });

    it("resume sweep skips terminal games and future deadlines", async () => {
      seedGame(db, { id: "closed1", status: "CLOSED" });
      seedGame(db, {
        id: "future1",
        status: "INVITED",
        acceptanceDeadline: "2026-09-22T12:00:00.000Z",
      });
      seedPlayer(db, "future1", "host1", "accepted", 0, "host");
      seedPlayer(db, "future1", "alice", "pending");

      await resumeOpenGames(schedDeps);

      const f = db.prepare("SELECT status FROM games WHERE id = 'future1'").get() as { status: string };
      expect(f.status).toBe("INVITED");
      expect(posts).toHaveLength(0);
      expect(deps.client.get).not.toHaveBeenCalled();
    });

    it("full chaos chain: collecting → multiple expired polls → FINALE → CLOSED", async () => {
      // Seed a game one poll away from the end
      const id = seedGame(db, { status: "ROUND", currentRound: 7, pot: 3, length: 8 });
      seedPlayer(db, id, "host1", "accepted", 20, "host");
      seedPlayer(db, id, "alice", "accepted", 15);
      seedPollRound(db, id, 7, "2026-09-21T11:00:00.000Z");
      for (let i = 1; i <= 8; i++) {
        seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
        seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);
      }
      for (let r = 1; r <= 6; r++) {
        db.prepare(
          `INSERT INTO rounds (game_id, number, status, winner_account_id, option_map_json) VALUES (?, ?, 'resolved', ?, '{}')`,
        ).run(id, r, r % 2 === 0 ? "alice" : "host1");
      }

      // Simulate "restart": only resume is called (no prior in-memory state)
      await resumeOpenGames(schedDeps);

      // Round 7 resolved → round 8 poll open (future expires_at from mock)
      const g = db.prepare("SELECT status, current_round FROM games WHERE id = ?").get(id) as {
        status: string;
        current_round: number;
      };
      expect(g.status).toBe("ROUND");
      expect(g.current_round).toBe(8);
      const r8 = db.prepare("SELECT status FROM rounds WHERE game_id = ? AND number = 8").get(id) as {
        status: string;
      };
      expect(r8.status).toBe("poll_open");

      // Force round 8 poll expired, then resume again (second "restart")
      db.prepare("UPDATE rounds SET poll_expires_at = ? WHERE game_id = ? AND number = 8").run(
        "2026-09-21T11:00:00.000Z",
        id,
      );
      await resumeOpenGames(schedDeps);

      const g2 = db.prepare("SELECT status FROM games WHERE id = ?").get(id) as { status: string };
      expect(g2.status).toBe("CLOSED");
      const rootPosts = posts.filter((p) => !(p.body as { in_reply_to_id?: string }).in_reply_to_id);
      expect(String((rootPosts.at(-1)!.body as { status: string }).status)).toMatch(/Champion|🏆/i);
    });
  });

  describe("Mastodon 429/5xx retry surface", () => {
    it("client retries on 429 then succeeds (covered in mastodon-client.spec; here ensure poller surfaces hard failures without cursor loss)", async () => {
      const list = [
        {
          id: "900",
          type: "mention" as const,
          created_at: "2026-09-21T12:00:00.000Z",
          account: { id: "id-host", acct: "host", username: "host" },
          status: {
            id: "s900",
            visibility: "public" as const,
            in_reply_to_id: null,
            content: "<p>@playlistbattle status</p>",
            mentions: [{ id: "bot-1", username: "playlistbattle", acct: "playlistbattle" }],
          },
        },
      ];
      (deps.client.get as ReturnType<typeof vi.fn>).mockResolvedValue(list);
      // status command with no games still posts a reply — make every post fail permanently
      (deps.client.post as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("HTTP 500"));

      await expect(pollNotifications(deps)).rejects.toThrow(/HTTP 500/);
      writeCursor(db, readCursor(db)); // sanity: cursor helpers work
      expect(readCursor(db).lastId).toBe("");
      expect(db.prepare("SELECT COUNT(*) AS c FROM processed_notifications").get()).toEqual({ c: 0 });
    });
  });
});
