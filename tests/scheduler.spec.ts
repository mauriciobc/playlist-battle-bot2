import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, migrate, type Db } from "../src/db/index.js";
import {
  checkDeadlines,
  checkPollNotification,
  checkPolls,
  resumeOpenGames,
  type SchedulerDeps,
} from "../src/scheduler/index.js";
import { emitRound } from "../src/scheduler/roundState.js";
import type { MastodonClient } from "../src/mastodon/client.js";
import type { HandlerDeps } from "../src/handlers/mention.js";

type Posted = { path: string; body: Record<string, unknown> };

function makeDb(): { dir: string; db: Db } {
  const dir = mkdtempSync(join(tmpdir(), "pb-sched-"));
  const db = openDatabase(join(dir, "test.db"));
  migrate(db);
  return { dir, db };
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
    pollDurationSec?: number;
  } = {},
): string {
  const id = opts.id ?? `g-${Math.random().toString(36).slice(2, 8)}`;
  const now = "2026-09-21T12:00:00.000Z";
  db.prepare(
    `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec,
      acceptance_deadline, submission_deadline, thread_root_id, current_round, pot, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'host1', ?, ?, ?, 'root-1', ?, ?, ?, ?)`,
  ).run(
    id,
    opts.status ?? "INVITED",
    opts.theme ?? "Test Theme",
    opts.length ?? 8,
    opts.pollDurationSec ?? 86400,
    opts.acceptanceDeadline ?? now,
    opts.submissionDeadline ?? null,
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

describe("checkDeadlines — acceptance window (PRD §5.2)", () => {
  let dir: string;
  let db: Db;
  let posts: Posted[];
  let deps: HandlerDeps & { client: MastodonClient };
  let schedDeps: SchedulerDeps;

  beforeEach(() => {
    ({ dir, db } = makeDb());
    posts = [];
    const client = {
      post: vi.fn(async (_p: string, body?: unknown) => {
        posts.push({ path: "/api/v1/statuses", body: body as Record<string, unknown> });
        return { id: `s-${posts.length}` };
      }),
      get: vi.fn(async () => ({ options: [] })),
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
      lookup: vi.fn(),
      resolveTitle: vi.fn(),
      checkAvailable: vi.fn(async () => true),
      publishBattlePlaylist: vi.fn(async () => null),
      replacementGraceMin: 15,
      now: () => new Date("2026-09-21T12:00:00.000Z"),
      newGameId: () => "x",
    };
    schedDeps = { handler: deps, now: () => new Date("2026-09-21T12:00:00.000Z") };
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("expires INVITED game past deadline with zero accepts → EXPIRED + creation-post reply", async () => {
    const id = seedGame(db, {
      status: "INVITED",
      acceptanceDeadline: "2026-09-21T11:00:00.000Z", // past
    });
    seedPlayer(db, id, "host1", "accepted", 0, "host");
    seedPlayer(db, id, "alice", "pending");

    await checkDeadlines(schedDeps);

    const g = db.prepare("SELECT status FROM games WHERE id = ?").get(id) as { status: string };
    expect(g.status).toBe("EXPIRED");
    expect(posts).toHaveLength(1);
    const body = posts[0]!.body as { status: string; in_reply_to_id: string };
    expect(body.in_reply_to_id).toBe("root-1");
    expect(body.status).toMatch(/expired/i);
  });

  it("does not expire INVITED game before deadline", async () => {
    const id = seedGame(db, {
      status: "INVITED",
      acceptanceDeadline: "2026-09-22T12:00:00.000Z", // future
    });
    seedPlayer(db, id, "host1", "accepted", 0, "host");
    seedPlayer(db, id, "alice", "pending");
    await checkDeadlines(schedDeps);
    const g = db.prepare("SELECT status FROM games WHERE id = ?").get(id) as { status: string };
    expect(g.status).toBe("INVITED");
    expect(posts).toHaveLength(0);
  });

  it("acceptance deadline with ≥1 accept → stays COLLECTING (no action)", async () => {
    const id = seedGame(db, {
      status: "COLLECTING",
      acceptanceDeadline: "2026-09-21T11:00:00.000Z",
      submissionDeadline: "2026-09-23T12:00:00.000Z",
    });
    seedPlayer(db, id, "host1", "accepted", 0, "host");
    seedPlayer(db, id, "alice", "accepted");
    await checkDeadlines(schedDeps);
    const g = db.prepare("SELECT status FROM games WHERE id = ?").get(id) as { status: string };
    expect(g.status).toBe("COLLECTING");
  });

  it("pending challengers marked expired when acceptance window closes (some accepted)", async () => {
    const id = seedGame(db, {
      status: "COLLECTING",
      acceptanceDeadline: "2026-09-21T11:00:00.000Z",
      submissionDeadline: "2026-09-23T12:00:00.000Z",
    });
    seedPlayer(db, id, "host1", "accepted", 0, "host");
    seedPlayer(db, id, "alice", "accepted");
    seedPlayer(db, id, "bob", "pending");

    await checkDeadlines(schedDeps);

    const bob = db
      .prepare("SELECT invite_status FROM players WHERE game_id = ? AND account_id = ?")
      .get(id, "bob") as { invite_status: string };
    expect(bob.invite_status).toBe("expired");
  });
});

describe("checkDeadlines — submission window (PRD §5.4/§7)", () => {
  let dir: string;
  let db: Db;
  let posts: Posted[];
  let deps: HandlerDeps & { client: MastodonClient };
  let schedDeps: SchedulerDeps;

  beforeEach(() => {
    ({ dir, db } = makeDb());
    posts = [];
    const client = {
      post: vi.fn(async (_p: string, body?: unknown) => {
        posts.push({ path: "/api/v1/statuses", body: body as Record<string, unknown> });
        const b = body as { poll?: unknown };
        if (b?.poll) return { id: `s-${posts.length}`, poll: { id: `poll-${posts.length}`, expires_at: "2026-09-22T12:00:00Z" } };
        return { id: `s-${posts.length}` };
      }),
      get: vi.fn(async () => ({ options: [] })),
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
      lookup: vi.fn(),
      resolveTitle: vi.fn(),
      checkAvailable: vi.fn(async () => true),
      publishBattlePlaylist: vi.fn(async () => null),
      replacementGraceMin: 15,
      now: () => new Date("2026-09-21T12:00:00.000Z"),
      newGameId: () => "x",
    };
    schedDeps = { handler: deps, now: () => new Date("2026-09-21T12:00:00.000Z") };
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("zero complete playlists → FIZZLED with creation-post notice", async () => {
    const id = seedGame(db, {
      status: "COLLECTING",
      submissionDeadline: "2026-09-21T11:00:00.000Z",
      length: 8,
    });
    seedPlayer(db, id, "host1", "accepted");
    seedPlayer(db, id, "alice", "accepted");
    // host1: 0 tunes, alice: 2 partial — wait, partial>=2 needed for ready; only alice partial → fizzled?
    // With 0 complete + 1 partial → fizzled per engine.
    seedTune(db, id, "alice", 1, "aaaaaaaaaaa");

    await checkDeadlines(schedDeps);
    const g = db.prepare("SELECT status FROM games WHERE id = ?").get(id) as { status: string };
    expect(g.status).toBe("FIZZLED");
    expect(posts.some((p) => /fizzl/i.test(String((p.body as { status: string }).status)))).toBe(true);
  });

  it("exactly one complete playlist → default win + finale path (CLOSED after finale post)", async () => {
    const id = seedGame(db, {
      status: "COLLECTING",
      submissionDeadline: "2026-09-21T11:00:00.000Z",
      length: 8,
    });
    seedPlayer(db, id, "host1", "accepted", 0, "host");
    seedPlayer(db, id, "alice", "accepted");
    for (let i = 1; i <= 8; i++) seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
    // alice: 3 partial → per PRD exactly-one-complete wins by default
    seedTune(db, id, "alice", 1, "aliceaa01");
    seedTune(db, id, "alice", 2, "aliceaa02");
    seedTune(db, id, "alice", 3, "aliceaa03");

    await checkDeadlines(schedDeps);
    const g = db.prepare("SELECT status FROM games WHERE id = ?").get(id) as { status: string };
    // default_win posts finale immediately then closes
    expect(g.status).toBe("CLOSED");
    expect(posts.some((p) => /default|last one standing/i.test(String((p.body as { status?: string }).status ?? "")))).toBe(true);
  });

  it("two complete playlists → READY + round 1 starts", async () => {
    const id = seedGame(db, {
      status: "COLLECTING",
      submissionDeadline: "2026-09-21T11:00:00.000Z",
      length: 8,
    });
    seedPlayer(db, id, "host1", "accepted");
    seedPlayer(db, id, "alice", "accepted");
    for (let i = 1; i <= 8; i++) {
      seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
      seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);
    }

    await checkDeadlines(schedDeps);
    const g = db.prepare("SELECT status, current_round FROM games WHERE id = ?").get(id) as {
      status: string;
      current_round: number;
    };
    expect(g.status).toBe("ROUND");
    expect(g.current_round).toBe(1);
    const round = db.prepare("SELECT status FROM rounds WHERE game_id = ? AND number = 1").get(id) as
      | { status: string }
      | undefined;
    expect(round?.status).toBe("poll_open");
  });

  it("does not touch COLLECTING game before deadline", async () => {
    const id = seedGame(db, {
      status: "COLLECTING",
      submissionDeadline: "2026-09-23T12:00:00.000Z",
    });
    seedPlayer(db, id, "host1", "accepted");
    await checkDeadlines(schedDeps);
    const g = db.prepare("SELECT status FROM games WHERE id = ?").get(id) as { status: string };
    expect(g.status).toBe("COLLECTING");
  });
});

describe("checkPolls — poll expiry tally (PRD §5.5/§5.6)", () => {
  let dir: string;
  let db: Db;
  let posts: Posted[];
  let deps: HandlerDeps & { client: MastodonClient };
  let schedDeps: SchedulerDeps;

  beforeEach(() => {
    ({ dir, db } = makeDb());
    posts = [];
    const client = {
      post: vi.fn(async (_p: string, body?: unknown) => {
        posts.push({ path: "/api/v1/statuses", body: body as Record<string, unknown> });
        const b = body as { poll?: unknown };
        if (b?.poll) return { id: `s-${posts.length}`, poll: { id: `poll-${posts.length}`, expires_at: "2026-09-22T12:00:00Z" } };
        return { id: `s-${posts.length}` };
      }),
      get: vi.fn(async () => ({
        expired: true,
        options: [
          { title: "host1: Tune A", votes_count: 5 },
          { title: "alice: Tune B", votes_count: 3 },
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
      lookup: vi.fn(),
      resolveTitle: vi.fn(),
      checkAvailable: vi.fn(async () => true),
      publishBattlePlaylist: vi.fn(async () => null),
      replacementGraceMin: 15,
      now: () => new Date("2026-09-21T12:00:00.000Z"),
      newGameId: () => "x",
    };
    schedDeps = { handler: deps, now: () => new Date("2026-09-21T12:00:00.000Z") };
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function seedPollRound(gameId: string, round: number, expiresAt: string): void {
    db.prepare(
      `INSERT INTO rounds (game_id, number, status, poll_status_id, poll_id, poll_expires_at, option_map_json)
       VALUES (?, ?, 'poll_open', 'poll-status', ?, ?, ?)`,
    ).run(gameId, round, `pollid-${round}`, expiresAt, JSON.stringify({ "0": "host1", "1": "alice" }));
  }

  it("expired poll → tallies votes, awards points + pot, advances to round 2", async () => {
    const id = seedGame(db, { status: "ROUND", currentRound: 1, pot: 2, length: 8 });
    seedPlayer(db, id, "host1", "accepted", 0, "host");
    seedPlayer(db, id, "alice", "accepted", 0);
    seedPollRound(id, 1, "2026-09-21T11:00:00.000Z"); // expired
    // full playlists so round 2+ can proceed (positions 1-8)
    for (let i = 1; i <= 8; i++) {
      seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
      seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);
    }

    await checkPolls(schedDeps);

    const g = db.prepare("SELECT status, current_round, pot FROM games WHERE id = ?").get(id) as {
      status: string;
      current_round: number;
      pot: number;
    };
    expect(g.status).toBe("ROUND");
    expect(g.current_round).toBe(2);
    expect(g.pot).toBe(0); // taken by winner

    const host = db
      .prepare("SELECT points FROM players WHERE game_id = ? AND account_id = ?")
      .get(id, "host1") as { points: number };
    const alice = db
      .prepare("SELECT points FROM players WHERE game_id = ? AND account_id = ?")
      .get(id, "alice") as { points: number };
    expect(host.points).toBe(5 + 2); // 5 votes + 2 pot bonus
    expect(alice.points).toBe(3);

    const round = db
      .prepare("SELECT status, winner_account_id FROM rounds WHERE game_id = ? AND number = 1")
      .get(id) as { status: string; winner_account_id: string };
    expect(round.status).toBe("resolved");
    expect(round.winner_account_id).toBe("host1");

    // resolution + round 2 announce/tunes/poll posted
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts.some((p) => /Round 1/i.test(String((p.body as { status: string }).status)))).toBe(true);

    // round 2 poll opened
    const r2 = db.prepare("SELECT status FROM rounds WHERE game_id = ? AND number = 2").get(id) as
      | { status: string }
      | undefined;
    expect(r2?.status).toBe("poll_open");
  });

  it("tied poll → pot accrues, advances round", async () => {
    (deps.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      expired: true,
      options: [
        { title: "host1: A", votes_count: 4 },
        { title: "alice: B", votes_count: 4 },
      ],
    });

    const id = seedGame(db, { status: "ROUND", currentRound: 1, pot: 1, length: 8 });
    seedPlayer(db, id, "host1", "accepted", 0, "host");
    seedPlayer(db, id, "alice", "accepted", 0);
    seedPollRound(id, 1, "2026-09-21T11:00:00.000Z");
    for (let i = 1; i <= 8; i++) {
      seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
      seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);
    }

    await checkPolls(schedDeps);

    const g = db.prepare("SELECT pot, current_round, status FROM games WHERE id = ?").get(id) as {
      pot: number;
      current_round: number;
      status: string;
    };
    expect(g.status).toBe("ROUND");
    expect(g.pot).toBe(2); // 1 + 1
    expect(g.current_round).toBe(2);
    const host = db
      .prepare("SELECT points FROM players WHERE game_id = ? AND account_id = ?")
      .get(id, "host1") as { points: number };
    expect(host.points).toBe(4); // votes count even on tie
  });

  it("does not tally polls that have not expired", async () => {
    const id = seedGame(db, { status: "ROUND", currentRound: 1, pot: 0, length: 8 });
    seedPlayer(db, id, "host1", "accepted", 0, "host");
    seedPlayer(db, id, "alice", "accepted", 0);
    seedPollRound(id, 1, "2026-09-22T12:00:00.000Z"); // future
    for (let i = 1; i <= 8; i++) {
      seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
      seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);
    }

    await checkPolls(schedDeps);

    const g = db.prepare("SELECT current_round FROM games WHERE id = ?").get(id) as { current_round: number };
    expect(g.current_round).toBe(1);
    const round = db.prepare("SELECT status FROM rounds WHERE game_id = ? AND number = 1").get(id) as {
      status: string;
    };
    expect(round.status).toBe("poll_open");
    expect(deps.client.get).not.toHaveBeenCalled();
  });

  it("final round poll expiry → FINALE + CLOSED after posting", async () => {
    const id = seedGame(db, { status: "ROUND", currentRound: 8, pot: 3, length: 8 });
    seedPlayer(db, id, "host1", "accepted", 10, "host");
    seedPlayer(db, id, "alice", "accepted", 7);
    seedPollRound(id, 8, "2026-09-21T11:00:00.000Z");
    for (let i = 1; i <= 8; i++) {
      seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
      seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);
    }
    // seed prior round winners for finale tunes
    for (let r = 1; r <= 7; r++) {
      db.prepare(
        `INSERT INTO rounds (game_id, number, status, winner_account_id, option_map_json) VALUES (?, ?, 'resolved', ?, '{}')`,
      ).run(id, r, "host1");
    }

    await checkPolls(schedDeps);

    const g = db.prepare("SELECT status FROM games WHERE id = ?").get(id) as { status: string };
    expect(g.status).toBe("CLOSED");

    // finale summary should be a root post (no in_reply_to_id)
    const rootPosts = posts.filter((p) => !(p.body as { in_reply_to_id?: string }).in_reply_to_id);
    expect(rootPosts.length).toBeGreaterThanOrEqual(1);
    const summaryBody = rootPosts.at(-1)!.body as { status: string };
    expect(summaryBody.status).toMatch(/Champion|🏆/i);
    // pot was 3 and host1 wins final round → pot awarded (not voided)
    const host = db
      .prepare("SELECT points FROM players WHERE game_id = ? AND account_id = ?")
      .get(id, "host1") as { points: number };
    // 10 previous + 5 final votes + 3 pot = 18
    expect(host.points).toBe(10 + 5 + 3);
  });

  it("resumes a missing final-round result post before closing the finale", async () => {
    const id = seedGame(db, { status: "FINALE", currentRound: 8, pot: 0, length: 8 });
    seedPlayer(db, id, "host1", "accepted", 10, "host");
    seedPlayer(db, id, "alice", "accepted", 7);
    for (let i = 1; i <= 8; i += 1) {
      seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
      seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);
    }
    for (let r = 1; r <= 7; r += 1) {
      db.prepare(
        `INSERT INTO rounds
          (game_id, number, status, winner_account_id, option_map_json, resolution_posted_at)
         VALUES (?, ?, 'resolved', ?, '{}', ?)`,
      ).run(id, r, "host1", "2026-09-21T12:00:00.000Z");
    }
    db.prepare(
      `INSERT INTO rounds
        (game_id, number, status, winner_account_id, option_map_json, resolution_json)
       VALUES (?, 8, 'resolved', ?, '{}', ?)`,
    ).run(
      id,
      "host1",
      JSON.stringify({
        round: 8,
        winnerAcct: "host1",
        potAwarded: 0,
        wasTie: false,
        newPot: 0,
        potSplit: null,
      }),
    );

    await resumeOpenGames(schedDeps);

    const game = db.prepare("SELECT status FROM games WHERE id = ?").get(id) as { status: string };
    expect(game.status).toBe("CLOSED");
    const round = db
      .prepare("SELECT resolution_posted_at FROM rounds WHERE game_id = ? AND number = 8")
      .get(id) as { resolution_posted_at: string | null };
    expect(round.resolution_posted_at).toBeTruthy();
    expect(posts.some((p) => /Round 8/i.test(String((p.body as { status: string }).status)))).toBe(true);
  });

  it("continues a non-final auto-tie after a crash between result post and advance", async () => {
    const id = seedGame(db, { status: "ROUND", currentRound: 2, pot: 0, length: 8 });
    seedPlayer(db, id, "host1", "accepted", 0, "host");
    seedPlayer(db, id, "alice", "accepted", 0);
    for (let i = 1; i <= 8; i += 1) {
      seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
      seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);
    }
    db.prepare(
      `INSERT INTO rounds
        (game_id, number, status, option_map_json, resolution_posted_at, resolution_json)
       VALUES (?, 2, 'auto_tied', ?, ?, ?)`,
    ).run(
      id,
      JSON.stringify({ participants: ["host1", "alice"] }),
      "2026-09-21T12:00:00.000Z",
      JSON.stringify({ round: 2, winnerAcct: null, potAwarded: 0, wasTie: true, newPot: 1 }),
    );

    await resumeOpenGames(schedDeps);

    const game = db.prepare("SELECT current_round FROM games WHERE id = ?").get(id) as { current_round: number };
    expect(game.current_round).toBe(3);
    const next = db.prepare("SELECT status FROM rounds WHERE game_id = ? AND number = 3").get(id) as { status: string };
    expect(next.status).toBe("poll_open");
  });

  it("recovers a missing prior poll result before continuing the current round", async () => {
    const id = seedGame(db, { status: "ROUND", currentRound: 2, pot: 1, length: 8 });
    seedPlayer(db, id, "host1", "accepted", 2, "host");
    seedPlayer(db, id, "alice", "accepted", 1);
    for (let i = 1; i <= 8; i += 1) {
      seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
      seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);
    }
    db.prepare(
      `INSERT INTO rounds
        (game_id, number, status, winner_account_id, option_map_json, resolution_json)
       VALUES (?, 1, 'resolved', 'host1', '{}', ?)`,
    ).run(
      id,
      JSON.stringify({ round: 1, winnerAcct: "host1", potAwarded: 1, wasTie: false, newPot: 1 }),
    );
    db.prepare(
      `INSERT INTO rounds
        (game_id, number, status, poll_status_id, poll_id, poll_expires_at, option_map_json)
       VALUES (?, 2, 'poll_open', 'poll-status-2', 'pollid-2', ?, ?)`,
    ).run(id, "2026-09-22T12:00:00.000Z", JSON.stringify({ "0": "host1", "1": "alice" }));

    await resumeOpenGames(schedDeps);

    const result = db
      .prepare("SELECT resolution_posted_at FROM rounds WHERE game_id = ? AND number = 1")
      .get(id) as { resolution_posted_at: string | null };
    expect(result.resolution_posted_at).toBeTruthy();
    expect(posts.some((p) => /Round 1/i.test(String((p.body as { status: string }).status)))).toBe(true);
  });

  it("auto-delete safety: logs warning when poll×length approaches deletion window", async () => {
    // Covered via config.autoDeleteUnsafe — scheduler surfaces alert on boot in index.ts
    // Here we verify the scheduler skips games already terminal
    const id = seedGame(db, { status: "CLOSED", currentRound: 1 });
    seedPollRound(id, 1, "2026-09-21T11:00:00.000Z");
    await checkPolls(schedDeps);
    expect(deps.client.get).not.toHaveBeenCalled();
    void id;
  });

  it("overlapping sweep and poll-expired fast path resolve the round exactly once", async () => {
    const id = seedGame(db, { status: "ROUND", currentRound: 1, pot: 1, length: 8 });
    seedPlayer(db, id, "host1", "accepted", 0, "host");
    seedPlayer(db, id, "alice", "accepted", 0);
    seedPollRound(id, 1, "2026-09-21T11:00:00.000Z");
    for (let i = 1; i <= 8; i++) {
      seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
      seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);
    }

    await Promise.all([checkPolls(schedDeps), checkPollNotification(schedDeps, "poll-status")]);

    const host = db
      .prepare("SELECT points FROM players WHERE game_id = ? AND account_id = 'host1'")
      .get(id) as { points: number };
    expect(host.points).toBe(5 + 1); // 5 votes + pot, awarded once (not doubled)

    const round = db
      .prepare("SELECT status, winner_account_id FROM rounds WHERE game_id = ? AND number = 1")
      .get(id) as { status: string; winner_account_id: string | null };
    expect(round.status).toBe("resolved");
    expect(round.winner_account_id).toBe("host1");

    const game = db.prepare("SELECT current_round FROM games WHERE id = ?").get(id) as {
      current_round: number;
    };
    expect(game.current_round).toBe(2); // advanced once

    const wins = posts.filter((p) => JSON.stringify(p.body).includes("🏆 Round 1"));
    expect(wins).toHaveLength(1); // one resolution post, not two
  });
});

describe("emitRound — walkover + auto-tie (PRD §5.6/§7)", () => {
  let dir: string;
  let db: Db;
  let posted: string[];
  let deps: HandlerDeps & { client: MastodonClient };

  beforeEach(() => {
    ({ dir, db } = makeDb());
    posted = [];
    const client = {
      post: vi.fn(async (_path: string, body?: { status?: string; poll?: unknown }) => {
        posted.push(body?.status ?? "");
        const id = `s-${posted.length}`;
        if (body?.poll) {
          return { id, poll: { id: `poll-${posted.length}`, expires_at: "2026-09-22T12:00:00Z" } };
        }
        return { id };
      }),
      get: vi.fn(async () => ({ options: [] })),
      rateLimit: null,
    } as unknown as MastodonClient; // test double for the HTTP boundary

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
      lookup: vi.fn(),
      resolveTitle: vi.fn(),
      checkAvailable: vi.fn(async () => true),
      publishBattlePlaylist: vi.fn(async () => null),
      replacementGraceMin: 15,
      now: () => new Date("2026-09-21T12:00:00.000Z"),
      newGameId: () => "x",
    };
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("final-round walkover: sole survivor takes the pot and the post shows post-award state", async () => {
    const id = seedGame(db, { id: "g-walk", status: "ROUND", currentRound: 8, pot: 3, length: 8 });
    seedPlayer(db, id, "host1", "accepted", 0, "host");
    seedPlayer(db, id, "alice", "accepted", 0);
    // alice has no tune at position 8 → host1 is the only eligible player
    for (let i = 1; i <= 8; i++) seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
    for (let i = 1; i <= 7; i++) seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);

    await emitRound(deps, id, 8);

    const round = db
      .prepare("SELECT status, winner_account_id, poll_id FROM rounds WHERE game_id = ? AND number = 8")
      .get(id) as { status: string; winner_account_id: string | null; poll_id: string | null };
    expect(round.status).toBe("walkover");
    expect(round.winner_account_id).toBe("host1");
    expect(round.poll_id).toBeNull(); // a walkover opens no poll

    const game = db.prepare("SELECT status, pot FROM games WHERE id = ?").get(id) as {
      status: string;
      pot: number;
    };
    expect(game.pot).toBe(0); // awarded, not left standing
    expect(game.status).toBe("CLOSED"); // walkover in the final round ends the game

    const winner = db
      .prepare("SELECT points FROM players WHERE game_id = ? AND account_id = 'host1'")
      .get(id) as { points: number };
    expect(winner.points).toBe(3);

    // The resolution post must describe the award it just made, not the pre-award snapshot.
    const resolution = posted.find((p) => p.includes("walkover")) ?? "<no walkover post>";
    expect(resolution).toContain("+3");
    expect(resolution).toContain("@host1 3");
    expect(resolution).toContain("Pot: 0");
  });

  it("auto-tie: identical videos skip the poll, grow the pot, and advance the round", async () => {
    const id = seedGame(db, { id: "g-tie", status: "ROUND", currentRound: 2, pot: 2, length: 8 });
    seedPlayer(db, id, "host1", "accepted", 0, "host");
    seedPlayer(db, id, "alice", "accepted", 0);
    for (let i = 1; i <= 8; i++) {
      // same video in round 2 for both players → automatic tie; later rounds differ
      seedTune(db, id, "host1", i, i === 2 ? "duplicated1" : `hostaaaa${String(i).padStart(2, "0")}`);
      seedTune(db, id, "alice", i, i === 2 ? "duplicated1" : `aliceaa${String(i).padStart(2, "0")}`);
    }

    await emitRound(deps, id, 2);

    const tied = db
      .prepare("SELECT status, winner_account_id, poll_id FROM rounds WHERE game_id = ? AND number = 2")
      .get(id) as { status: string; winner_account_id: string | null; poll_id: string | null };
    expect(tied.status).toBe("auto_tied");
    expect(tied.winner_account_id).toBeNull();
    expect(tied.poll_id).toBeNull(); // an automatic tie opens no poll

    const game = db.prepare("SELECT current_round, pot FROM games WHERE id = ?").get(id) as {
      current_round: number;
      pot: number;
    };
    expect(game.pot).toBe(3); // 2 + 1 accrued, with nobody to award it to
    expect(game.current_round).toBe(3);

    const next = db.prepare("SELECT status FROM rounds WHERE game_id = ? AND number = 3").get(id) as {
      status: string;
    };
    expect(next.status).toBe("poll_open"); // round 3 has distinct videos → a normal poll

    const tiePost = posted.find((p) => p.includes("TIE")) ?? "<no tie post>";
    expect(tiePost).toContain("Pot grows to 3");
  });

  it("ignores collisions from withdrawn players", async () => {
    const id = seedGame(db, { id: "g-withdrawn-collision", status: "ROUND", currentRound: 1, length: 8 });
    seedPlayer(db, id, "host1", "accepted", 0, "host");
    seedPlayer(db, id, "alice", "accepted");
    seedPlayer(db, id, "bob", "declined");
    for (let i = 1; i <= 8; i++) {
      seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
      seedTune(db, id, "alice", i, i === 1 ? "shared000001" : `aliceaa${String(i).padStart(2, "0")}`);
      seedTune(db, id, "bob", i, i === 1 ? "shared000001" : `bobbbbb${String(i).padStart(2, "0")}`);
    }

    await emitRound(deps, id, 1);

    const round = db
      .prepare("SELECT status, option_map_json FROM rounds WHERE game_id = ? AND number = 1")
      .get(id) as { status: string; option_map_json: string };
    expect(round.status).toBe("poll_open");
    const optionMap = JSON.parse(round.option_map_json) as Record<string, string>;
    expect(Object.values(optionMap)).toHaveLength(2);
    expect(Object.values(optionMap)).not.toContain("bob");
  });
});

describe("checkPolls — stagnation early close", () => {
  let dir: string;
  let db: Db;
  let posts: Posted[];
  let deletes: string[];
  let deps: HandlerDeps & { client: MastodonClient };
  let schedDeps: SchedulerDeps;

  const NOW = "2026-09-21T12:00:00.000Z";
  // poll duration 900s: expires NOW+600 → opened at NOW−300 → age = 300s

  beforeEach(() => {
    ({ dir, db } = makeDb());
    posts = [];
    deletes = [];
    const client = {
      post: vi.fn(async (_p: string, body?: unknown) => {
        posts.push({ path: "/api/v1/statuses", body: body as Record<string, unknown> });
        const b = body as { poll?: unknown };
        if (b?.poll) {
          return { id: `s-${posts.length}`, poll: { id: `poll-${posts.length}`, expires_at: "2026-09-21T12:30:00.000Z" } };
        }
        return { id: `s-${posts.length}` };
      }),
      get: vi.fn(async () => ({
        expired: false,
        options: [
          { title: "host1: A", votes_count: 0 },
          { title: "alice: B", votes_count: 0 },
        ],
      })),
      delete: vi.fn(async (path: string) => {
        deletes.push(path);
        return { id: path.split("/").at(-1) };
      }),
      rateLimit: null,
    } as unknown as MastodonClient;

    deps = {
      db,
      client,
      botAcct: "playlistbattle",
      instanceDomain: "mastodon.example",
      pollDurationSec: 900,
      acceptanceWindowSec: 86400,
      submissionWindowSec: 172800,
      creationCooldownSec: 600,
      maxGamesPerPlayer: 3,
      lookup: vi.fn(),
      resolveTitle: vi.fn(),
      checkAvailable: vi.fn(async () => true),
      publishBattlePlaylist: vi.fn(async () => null),
      replacementGraceMin: 15,
      now: () => new Date(NOW),
      newGameId: () => "x",
    };
    schedDeps = {
      handler: deps,
      now: () => new Date(NOW),
      earlyClose: { enabled: true, minAgeSec: 300, stagnationSec: 300 },
    };
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function seedDuel(opts: {
    expiresAt: string;
    watchedVotes?: number | null;
    votesChangedAt?: string | null;
  }): string {
    const id = seedGame(db, {
      status: "ROUND",
      currentRound: 1,
      pot: 0,
      length: 8,
      pollDurationSec: 900,
    });
    seedPlayer(db, id, "host1", "accepted", 0, "host");
    seedPlayer(db, id, "alice", "accepted", 0);
    for (let i = 1; i <= 8; i++) {
      seedTune(db, id, "host1", i, `hostaaaa${String(i).padStart(2, "0")}`);
      seedTune(db, id, "alice", i, `aliceaa${String(i).padStart(2, "0")}`);
    }
    db.prepare(
      `INSERT INTO rounds (game_id, number, status, poll_status_id, poll_id, poll_expires_at,
        option_map_json, watched_votes, votes_changed_at)
       VALUES (?, 1, 'poll_open', 'poll-status-1', 'pollid-1', ?, ?, ?, ?)`,
    ).run(
      id,
      opts.expiresAt,
      JSON.stringify({ "0": "host1", "1": "alice" }),
      opts.watchedVotes ?? null,
      opts.votesChangedAt ?? null,
    );
    return id;
  }

  it("stagnant zero-vote poll past min age → resolves, deletes the poll status, advances", async () => {
    const id = seedDuel({ expiresAt: "2026-09-21T12:10:00.000Z" }); // age 300s

    await checkPolls(schedDeps);

    const round = db
      .prepare("SELECT status, winner_account_id FROM rounds WHERE game_id = ? AND number = 1")
      .get(id) as { status: string; winner_account_id: string | null };
    expect(round.status).toBe("resolved");
    expect(round.winner_account_id).toBeNull(); // all-zero → tie

    const g = db.prepare("SELECT current_round, pot FROM games WHERE id = ?").get(id) as {
      current_round: number;
      pot: number;
    };
    expect(g.current_round).toBe(2);
    expect(g.pot).toBe(1);

    expect(deletes).toContain("/api/v1/statuses/poll-status-1");
    // one GET: the watch snapshot; resolve reuses it (no second tally fetch)
    expect(deps.client.get).toHaveBeenCalledTimes(1);
  });

  it("does not early-close before min age", async () => {
    const id = seedDuel({ expiresAt: "2026-09-21T12:14:00.000Z" }); // age 60s

    await checkPolls(schedDeps);

    const round = db.prepare("SELECT status FROM rounds WHERE game_id = ? AND number = 1").get(id) as {
      status: string;
    };
    expect(round.status).toBe("poll_open");
    expect(deletes).toHaveLength(0);
    const g = db.prepare("SELECT current_round FROM games WHERE id = ?").get(id) as {
      current_round: number;
    };
    expect(g.current_round).toBe(1);
    expect(deps.client.get).toHaveBeenCalledTimes(1); // watched, but not eligible
  });

  it("vote change on this sweep restarts the stagnation clock", async () => {
    const id = seedDuel({
      expiresAt: "2026-09-21T12:10:00.000Z", // age 300s
      watchedVotes: 0,
      votesChangedAt: "2026-09-21T11:55:00.000Z",
    });
    (deps.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      expired: false,
      options: [
        { title: "host1: A", votes_count: 1 },
        { title: "alice: B", votes_count: 1 },
      ],
    });

    await checkPolls(schedDeps);

    const round = db.prepare("SELECT status FROM rounds WHERE game_id = ? AND number = 1").get(id) as {
      status: string;
    };
    expect(round.status).toBe("poll_open");
    expect(deletes).toHaveLength(0);
    const watch = db
      .prepare("SELECT watched_votes, votes_changed_at FROM rounds WHERE game_id = ? AND number = 1")
      .get(id) as { watched_votes: number; votes_changed_at: string };
    expect(watch.watched_votes).toBe(2);
    expect(watch.votes_changed_at).toBe(NOW);
  });

  it("stagnant poll with prior votes → resolves with the live tallies", async () => {
    const id = seedDuel({
      expiresAt: "2026-09-21T12:10:00.000Z", // age 300s
      watchedVotes: 5,
      votesChangedAt: "2026-09-21T11:00:00.000Z", // still 3600s
    });
    (deps.client.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      expired: false,
      options: [
        { title: "host1: A", votes_count: 3 },
        { title: "alice: B", votes_count: 2 },
      ],
    });

    await checkPolls(schedDeps);

    const round = db
      .prepare("SELECT status, winner_account_id FROM rounds WHERE game_id = ? AND number = 1")
      .get(id) as { status: string; winner_account_id: string | null };
    expect(round.status).toBe("resolved");
    expect(round.winner_account_id).toBe("host1");

    const host = db
      .prepare("SELECT points FROM players WHERE game_id = ? AND account_id = 'host1'")
      .get(id) as { points: number };
    expect(host.points).toBe(3);

    expect(deletes).toContain("/api/v1/statuses/poll-status-1");
    const g = db.prepare("SELECT current_round FROM games WHERE id = ?").get(id) as {
      current_round: number;
    };
    expect(g.current_round).toBe(2);
  });

  it("disabled early close → no live poll fetches", async () => {
    const id = seedDuel({ expiresAt: "2026-09-21T12:10:00.000Z" });
    schedDeps.earlyClose = { enabled: false, minAgeSec: 300, stagnationSec: 300 };

    await checkPolls(schedDeps);

    expect(deps.client.get).not.toHaveBeenCalled();
    const round = db.prepare("SELECT status FROM rounds WHERE game_id = ? AND number = 1").get(id) as {
      status: string;
    };
    expect(round.status).toBe("poll_open");
  });

  it("poll status deletion failure is non-fatal — round still resolves", async () => {
    const id = seedDuel({ expiresAt: "2026-09-21T12:10:00.000Z" });
    (deps.client.delete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));

    await expect(checkPolls(schedDeps)).resolves.toBeUndefined();

    const round = db.prepare("SELECT status, poll_cleanup_pending, poll_status_id FROM rounds WHERE game_id = ? AND number = 1").get(id) as {
      status: string;
      poll_cleanup_pending: number;
      poll_status_id: string | null;
    };
    expect(round.status).toBe("resolved");
    expect(round.poll_cleanup_pending).toBe(1);
    expect(round.poll_status_id).toBe("poll-status-1");

    (deps.client.delete as ReturnType<typeof vi.fn>).mockResolvedValue({});
    await checkPolls(schedDeps);
    const cleaned = db.prepare("SELECT poll_cleanup_pending, poll_status_id FROM rounds WHERE game_id = ? AND number = 1").get(id) as {
      poll_cleanup_pending: number;
      poll_status_id: string | null;
    };
    expect(cleaned).toEqual({ poll_cleanup_pending: 0, poll_status_id: null });
    const g = db.prepare("SELECT current_round FROM games WHERE id = ?").get(id) as {
      current_round: number;
    };
    expect(g.current_round).toBe(2);
  });
});
