import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate, openDatabase, type Db } from "../src/db/index.js";
import { type HandlerDeps } from "../src/handlers/mention.js";
import { checkPollNotification, type SchedulerDeps } from "../src/scheduler/index.js";
import { pollNotifications } from "../src/mastodon/poller.js";
import type { MastodonClient } from "../src/mastodon/client.js";
import type { RawNotification } from "../src/mastodon/notifications.js";

/**
 * Phase 8 simulated E2E: full lifecycle through the notification pipeline —
 * create → accept → submit (2 players × 8 tunes) → 8 poll rounds → finale → CLOSED.
 * Mastodon is mocked; handlers, engine, scheduler, poller are real.
 */

type Posted = { path: string; body: Record<string, unknown> };

function makeId(acct: string, i: number): string {
  const base = acct.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().padEnd(8, "z");
  return `${base}${String(i).padStart(3, "0")}`.slice(0, 11);
}

let notifSeq = 0;
let statusSeq = 0;

function mentionN(
  accountId: string,
  accountAcct: string,
  content: string,
  opts: { visibility?: string; statusId?: string } = {},
): RawNotification {
  notifSeq += 1;
  statusSeq += 1;
  return {
    id: String(1000 + notifSeq),
    type: "mention",
    created_at: "2026-09-21T12:00:00.000Z",
    account: { id: accountId, acct: accountAcct, username: accountAcct.split("@")[0]! },
    status: {
      id: opts.statusId ?? `s-${statusSeq}`,
      visibility: opts.visibility ?? "public",
      in_reply_to_id: null,
      content,
      mentions: [{ id: "bot-1", username: "playlistbattle", acct: "playlistbattle" }],
    },
  };
}

function pollN(statusId: string): RawNotification {
  notifSeq += 1;
  return {
    id: String(1000 + notifSeq),
    type: "poll",
    created_at: "2026-09-21T12:00:00.000Z",
    account: { id: "bot-1", acct: "playlistbattle", username: "playlistbattle" },
    status: {
      id: statusId,
      visibility: "public",
      in_reply_to_id: null,
      content: "",
      mentions: [],
    },
  };
}

describe("Phase 8 — simulated full-game E2E", () => {
  let dir: string;
  let db: Db;
  let posts: Posted[];
  let deps: HandlerDeps;
  let queue: RawNotification[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pb-e2e-"));
    db = openDatabase(join(dir, "test.db"));
    migrate(db);
    posts = [];
    queue = [];
    notifSeq = 0;
    statusSeq = 0;

    const client = {
      post: vi.fn(async (_path: string, body?: unknown) => {
        const b = (body ?? {}) as Record<string, unknown>;
        posts.push({ path: "/api/v1/statuses", body: b });
        const id = `s-${posts.length}`;
        if (b.poll) {
          return { id, poll: { id: `poll-${posts.length}`, expires_at: "2026-09-22T12:00:00Z" } };
        }
        return { id };
      }),
      get: vi.fn(async (path: string) => {
        if (path.startsWith("/api/v1/notifications")) {
          const batch = queue;
          queue = [];
          return batch;
        }
        if (path.startsWith("/api/v1/polls/")) {
          // host wins every round (option 0 is first eligible player's tune)
          return {
            expired: true,
            options: [
              { title: "host: A", votes_count: 5 },
              { title: "alice: B", votes_count: 3 },
            ],
          };
        }
        return {};
      }),
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
      lookup: vi.fn(async (acct: string) => {
        const username = acct.split("@")[0]!;
        return {
          id: `id-${username}`,
          acct: username,
          username,
          local: true,
        };
      }),
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
      newGameId: () => "e2e-game-1",
    };
    deps.onPollExpired = async (statusId) => {
      const schedDeps: SchedulerDeps = { handler: deps, now: deps.now };
      await checkPollNotification(schedDeps, statusId);
    };
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("2 players, 8-length: create → accept → submit → 8 rounds → finale thread → CLOSED", async () => {
    // 1. Host creates the game
    queue.push(
      mentionN(
        "id-host",
        "host",
        `<p>@playlistbattle newgame "80s Synth" 8 @alice</p>`,
      ),
    );
    await pollNotifications(deps);

    let game = db.prepare("SELECT id, status, current_round FROM games").get() as {
      id: string;
      status: string;
      current_round: number;
    };
    expect(game.status).toBe("INVITED");
    expect(game.id).toBe("e2e-game-1");
    expect(posts.length).toBeGreaterThanOrEqual(2); // creation reply + invite DM

    // 2. Alice accepts via DM
    queue.push(mentionN("id-alice", "alice", "<p>accept</p>", { visibility: "direct" }));
    await pollNotifications(deps);
    game = db.prepare("SELECT id, status, current_round FROM games").get() as {
      id: string;
      status: string;
      current_round: number;
    };
    expect(game.status).toBe("COLLECTING");

    // 3. Both players submit full 8-tune playlists (one-per-line fast path)
    for (const acct of ["host", "alice"]) {
      const links = Array.from({ length: 8 }, (_, i) =>
        `https://www.youtube.com/watch?v=${makeId(acct, i)}`,
      ).join("\n");
      queue.push(
        mentionN(`id-${acct}`, acct, `<p>${links}</p>`, { visibility: "direct" }),
      );
      await pollNotifications(deps);
    }

    game = db.prepare("SELECT id, status, current_round FROM games").get() as {
      id: string;
      status: string;
      current_round: number;
    };
    expect(game.status).toBe("ROUND");
    expect(game.current_round).toBe(1);
    const gameId = game.id;

    const tuneCount = db.prepare("SELECT COUNT(*) AS c FROM tunes").get() as { c: number };
    expect(tuneCount.c).toBe(16);

    // Round 1 poll is open
    const r1 = db
      .prepare("SELECT status, poll_status_id FROM rounds WHERE game_id = ? AND number = 1")
      .get(gameId) as { status: string; poll_status_id: string };
    expect(r1.status).toBe("poll_open");

    // 4. Drive all 8 rounds via poll_expired notifications
    for (let round = 1; round <= 8; round += 1) {
      const row = db
        .prepare("SELECT status, poll_status_id FROM rounds WHERE game_id = ? AND number = ?")
        .get(gameId, round) as { status: string; poll_status_id: string } | undefined;
      expect(row?.status).toBe("poll_open");
      db.prepare("UPDATE rounds SET poll_expires_at = ? WHERE game_id = ? AND number = ?")
        .run("2025-12-31T23:59:59.000Z", gameId, round);
      queue.push(pollN(row!.poll_status_id));
      await pollNotifications(deps);
    }

    // 5. Game CLOSED with finale thread
    const final = db.prepare("SELECT status, pot, current_round FROM games WHERE id = ?").get(gameId) as {
      status: string;
      pot: number;
      current_round: number;
    };
    expect(final.status).toBe("CLOSED");
    expect(final.current_round).toBe(8);

    const rounds = db
      .prepare("SELECT status, winner_account_id FROM rounds WHERE game_id = ? ORDER BY number")
      .all(gameId) as { status: string; winner_account_id: string | null }[];
    expect(rounds).toHaveLength(8);
    expect(rounds.every((r) => r.status === "resolved")).toBe(true);
    expect(rounds.every((r) => r.winner_account_id !== null)).toBe(true);

    // host won every poll (5 > 3 votes) → 8 points + pot takeaways
    const host = db
      .prepare("SELECT points FROM players WHERE game_id = ? AND account_id = 'id-host'")
      .get(gameId) as { points: number };
    expect(host.points).toBeGreaterThan(0);

    // Finale: new root post (no in_reply_to) mentioning champion
    const rootPosts = posts.filter((p) => !(p.body.in_reply_to_id as string | undefined));
    expect(rootPosts.length).toBeGreaterThanOrEqual(1);
    const finale = rootPosts.at(-1)!.body as { status: string };
    expect(finale.status).toMatch(/Champion|🏆/i);
    expect(finale.status).toContain("80s Synth");

    // No open polls left
    const openPolls = db
      .prepare("SELECT COUNT(*) AS c FROM rounds WHERE status = 'poll_open'")
      .get() as { c: number };
    expect(openPolls.c).toBe(0);

    // Cursor advanced past every notification
    const cursor = db.prepare("SELECT last_notification_id FROM cursor WHERE id = 1").get() as {
      last_notification_id: string;
    };
    expect(BigInt(cursor.last_notification_id)).toBeGreaterThan(0n);
  });
});
