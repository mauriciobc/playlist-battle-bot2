import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, migrate, type Db } from "../src/db/index.js";
import {
  postRound,
  postRoundResolution,
  postFinale,
  postSideEffect,
  tallyPoll,
  type PostRoundResult,
} from "../src/mastodon/posts.js";
import type { MastodonClient } from "../src/mastodon/client.js";
import type { Game, Player, Tune } from "../src/game/types.js";

type Posted = { path: string; body: Record<string, unknown> };

function mockClient(posts: Posted[], pollTally?: unknown) {
  return {
    post: vi.fn(async (path: string, body?: unknown) => {
      posts.push({ path, body: body as Record<string, unknown> });
      const id = `status-${posts.length}`;
      // poll posts get a poll object back
      if (body && typeof body === "object" && "poll" in (body as object)) {
        return {
          id,
          poll: {
            id: `poll-${posts.length}`,
            expires_at: "2026-09-22T12:00:00.000Z",
            ...(pollTally as object),
          },
        };
      }
      return { id };
    }),
    get: vi.fn(async () => pollTally ?? {}),
    rateLimit: null,
  } as unknown as MastodonClient;
}

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: "g1",
    status: "ROUND",
    theme: "80s Synth",
    playlistLength: 8,
    hostAccountId: "a",
    pollDurationSec: 86400,
    acceptanceDeadline: null,
    submissionDeadline: null,
    threadRootId: "root-1",
    currentRound: 1,
    pot: 2,
    battlePlaylistId: null,
    createdAt: "2026-09-21T12:00:00.000Z",
    updatedAt: "2026-09-21T12:00:00.000Z",
    ...overrides,
  };
}

function player(id: string, acct = id, points = 0): Player {
  return {
    accountId: id,
    acct,
    displayName: null,
    role: id === "a" ? "host" : "challenger",
    inviteStatus: "accepted",
    points,
    joinedAt: null,
  };
}

function tune(accountId: string, position: number, videoId: string, title: string): Tune {
  return {
    accountId,
    position,
    videoId,
    title,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

describe("postRound (PRD §5.5)", () => {
  let posts: Posted[];
  let client: MastodonClient;

  beforeEach(() => {
    posts = [];
    client = mockClient(posts);
  });

  it("keeps optionMap aligned even when poll options collide and get suffixed", async () => {
    const g = game();
    const players = [player("a", "dupe"), player("b", "dupe"), player("c", "carol")];
    const tunes = [
      tune("a", 1, "aaaaaaaaaaa", "Same Song"),
      tune("b", 1, "bbbbbbbbbbb", "Same Song"),
      tune("c", 1, "ccccccccccc", "Africa"),
    ];
    const result: PostRoundResult = await postRound(client, g, players, tunes, 1);

    // dedupePollOptions suffixes rather than drops — indices must stay aligned
    const pollPost = posts.at(-1)!.body as { poll?: { options: string[] } };
    expect(pollPost.poll!.options).toHaveLength(3);
    expect(Object.keys(result.optionMap).sort()).toEqual(["0", "1", "2"]);
    expect(Object.values(result.optionMap).sort()).toEqual(["a", "b", "c"]);
  });

  it("posts announce → one tune post per player → poll, threaded", async () => {
    const g = game();
    const players = [player("a", "alice"), player("b", "bob"), player("c", "carol")];
    const tunes = [
      tune("a", 1, "aaaaaaaaaaa", "Take On Me"),
      tune("b", 1, "bbbbbbbbbbb", "Blue Monday"),
      tune("c", 1, "ccccccccccc", "Africa"),
    ];
    const result: PostRoundResult = await postRound(client, g, players, tunes, 1);

    // 1 announce + 3 tunes + 1 poll = 5
    expect(posts).toHaveLength(5);

    const announce = posts[0]!.body as { status: string; in_reply_to_id: string };
    expect(announce.in_reply_to_id).toBe("root-1");
    expect(announce.status).toMatch(/Round 1/);
    expect(announce.status).toMatch(/Pot: 2/);

    // tune posts are replies to announce, carry link for full embed
    const tune1 = posts[1]!.body as { status: string; in_reply_to_id: string };
    expect(tune1.in_reply_to_id).toBe("status-1");
    expect(tune1.status).toContain("https://www.youtube.com/watch?v=aaaaaaaaaaa");
    expect(tune1.status).toContain("Take On Me");

    // each subsequent tune replies to previous (linear thread)
    const tune2 = posts[2]!.body as { in_reply_to_id: string };
    expect(tune2.in_reply_to_id).toBe("status-2");

    // poll
    const poll = posts[4]!.body as {
      status: string;
      in_reply_to_id: string;
      poll: { options: string[]; expires_in: number };
    };
    expect(poll.in_reply_to_id).toBe("status-4");
    expect(poll.poll.expires_in).toBe(86400);
    expect(poll.poll.options).toHaveLength(3); // one per player (PRD §2.2)
    for (const opt of poll.poll.options) {
      expect(opt.length).toBeLessThanOrEqual(25); // PRD §2.3
    }

    expect(result.optionMap).toEqual({ "0": "a", "1": "b", "2": "c" });
    expect(result.pollId).toBe("poll-5");
    expect(result.pollStatusId).toBe("status-5");
    expect(result.pollExpiresAt).toBeTruthy();
  });

  it("excludes players with no tune this round from the poll (PRD §7)", async () => {
    const g = game();
    const players = [
      player("a", "alice"),
      { ...player("b", "bob"), inviteStatus: "declined" as const },
      player("c", "carol"),
    ];
    const tunes = [
      tune("a", 1, "aaaaaaaaaaa", "Take On Me"),
      tune("c", 1, "ccccccccccc", "Africa"),
    ];
    const result = await postRound(client, g, players, tunes, 1);
    // announce + 2 tunes + poll
    expect(posts).toHaveLength(4);
    const poll = posts[3]!.body as { poll: { options: string[] } };
    expect(poll.poll.options).toHaveLength(2);
    expect(Object.values(result.optionMap).sort()).toEqual(["a", "c"]);
  });

  it("poll option includes abbreviated title within 25 chars for long titles", async () => {
    posts.length = 0;
    const g = game();
    const players = [player("a", "averyveryverylongplayername"), player("b", "bob")];
    const tunes = [
      tune("a", 1, "aaaaaaaaaaa", "An Extremely Long Song Title That Goes On And On Forever"),
      tune("b", 1, "bbbbbbbbbbb", "Short"),
    ];
    await postRound(client, g, players, tunes, 1);
    const poll = posts.at(-1)!.body as { poll: { options: string[] } };
    for (const opt of poll.poll.options) expect(opt.length).toBeLessThanOrEqual(25);
  });

  it("keeps the round announcement within Mastodon's post limit", async () => {
    const g = game({ theme: "x".repeat(120) });
    const players = [
      player("a", "a".repeat(30)),
      player("b", "b".repeat(30)),
      player("c", "c".repeat(30)),
      player("d", "d".repeat(30)),
    ];
    const tunes = [
      tune("a", 1, "aaaaaaaaaaa", "A"),
      tune("b", 1, "bbbbbbbbbbb", "B"),
      tune("c", 1, "ccccccccccc", "C"),
      tune("d", 1, "ddddddddddd", "D"),
    ];

    await postRound(client, g, players, tunes, 1);

    const announce = posts[0]!.body as { status: string };
    expect(announce.status.length).toBeLessThanOrEqual(500);
  });

  it("dedupes colliding poll options (Mastodon rejects duplicates with 422)", async () => {
    posts.length = 0;
    const g = game();
    // same display name + same video title -> identical truncated options
    const players = [
      { ...player("a", "sam"), displayName: "sam" },
      { ...player("b", "sam"), displayName: "sam" },
    ];
    const tunes = [
      tune("a", 1, "aaaaaaaaaaa", "Official Video"),
      tune("b", 1, "bbbbbbbbbbb", "Official Video"),
    ];
    await postRound(client, g, players, tunes, 1);
    const poll = posts.at(-1)!.body as { poll: { options: string[] } };
    expect(poll.poll.options).toHaveLength(2);
    expect(new Set(poll.poll.options).size).toBe(2);
    for (const opt of poll.poll.options) expect(opt.length).toBeLessThanOrEqual(25);
  });

  it("rejects a poll creation response without a poll id and expiry", async () => {
    const malformed = {
      ...mockClient(posts),
      post: vi.fn(async () => ({ id: "status-without-poll" })),
    } as unknown as MastodonClient;

    await expect(
      postRound(
        malformed,
        game(),
        [player("a", "alice"), player("b", "bob")],
        [
          tune("a", 1, "aaaaaaaaaaa", "A"),
          tune("b", 1, "bbbbbbbbbbb", "B"),
        ],
        1,
      ),
    ).rejects.toThrow(/valid poll id and expiry/);
  });

  it("keeps the canonical YouTube link as the only detectable URL when a title contains a URL", async () => {
    posts.length = 0;
    const g = game();
    const players = [player("a", "alice"), player("b", "bob")];
    const tunes = [
      tune("a", 1, "aaaaaaaaaaa", "My jam https://evil.example/track remix"),
      tune("b", 1, "bbbbbbbbbbb", "Blue Monday"),
    ];
    await postRound(client, g, players, tunes, 1);
    const tunePost = posts[1]!.body as { status: string };
    // Mastodon scans for https:// sequences to pick the preview card URL;
    // exactly one must remain (the canonical embed link).
    expect(tunePost.status.split("https://")).toHaveLength(2);
    expect(tunePost.status).toContain("https://www.youtube.com/watch?v=aaaaaaaaaaa");
  });
});

describe("tallyPoll", () => {
  it("maps poll option indices back to accountIds via optionMap", async () => {
    const client = mockClient([], {
      expired: true,
      options: [
        { title: "alice: Take On Me", votes_count: 5 },
        { title: "bob: Blue Monday", votes_count: 3 },
        { title: "carol: Africa", votes_count: 1 },
      ],
    });
    const optionMap = { "0": "a", "1": "b", "2": "c" };
    const tallies = await tallyPoll(client, "poll-1", optionMap);
    expect(tallies).toEqual([
      { accountId: "a", votes: 5 },
      { accountId: "b", votes: 3 },
      { accountId: "c", votes: 1 },
    ]);
  });

  it("rejects extra options that are not in the stored map", async () => {
    const client = mockClient([], {
      expired: true,
      options: [
        { title: "x", votes_count: 1 },
        { title: "bob: y", votes_count: 2 },
      ],
    });
    await expect(tallyPoll(client, "p", { "1": "b" })).rejects.toThrow(/do not match/);
  });
});

describe("postRoundResolution (PRD §5.6)", () => {
  it("announces winner, pot bonus, standings", async () => {
    const posts: Posted[] = [];
    const client = mockClient(posts);
    const g = game({ pot: 0 });
    const players = [player("a", "alice", 9), player("b", "bob", 4)];
    await postRoundResolution(client, g, players, {
      round: 1,
      winnerAcct: "alice",
      potAwarded: 2,
      wasTie: false,
      newPot: 0,
    });
    const body = posts[0]!.body as { status: string; in_reply_to_id: string };
    expect(body.status).toMatch(/Round 1/);
    expect(body.status).toMatch(/alice|Winner/i);
    expect(body.status).toMatch(/\+2|pot/i);
    expect(body.in_reply_to_id).toBe("root-1");
  });

  it("announces tie and pot accrual", async () => {
    const posts: Posted[] = [];
    const client = mockClient(posts);
    const g = game({ pot: 3 });
    await postRoundResolution(client, g, [player("a"), player("b")], {
      round: 2,
      winnerAcct: null,
      potAwarded: 0,
      wasTie: true,
      newPot: 4,
    });
    const body = posts[0]!.body as { status: string };
    expect(body.status).toMatch(/tie/i);
    expect(body.status).toMatch(/pot.*4|4.*pot/i);
  });

  it("announces final-round pot split instead of pot accrual (v1.1 1.3)", async () => {
    const posts: Posted[] = [];
    const client = mockClient(posts);
    const g = game({ pot: 0 });
    await postRoundResolution(client, g, [player("a"), player("b")], {
      round: 8,
      winnerAcct: null,
      potAwarded: 0,
      wasTie: true,
      newPot: 0,
      potSplit: { total: 6, each: 3, count: 2 },
    });
    const body = posts[0]!.body as { status: string };
    expect(body.status).toMatch(/FINAL TIE|split/i);
    expect(body.status).toContain("6");
    expect(body.status).toContain("3");
  });
});

describe("postFinale (PRD §5.7)", () => {
  it("creates NEW thread: summary first, then one post per winning tune", async () => {
    const posts: Posted[] = [];
    const client = mockClient(posts);
    const g = game({ status: "FINALE", threadRootId: "old-root" });
    const players = [player("a", "alice", 20), player("b", "bob", 11)];
    const winningTunes = [
      { round: 1, accountId: "a", videoId: "aaaaaaaaaaa", title: "Take On Me", canonicalUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa" },
      { round: 3, accountId: "b", videoId: "bbbbbbbbbbb", title: "Blue Monday", canonicalUrl: "https://www.youtube.com/watch?v=bbbbbbbbbbb" },
    ];

    const summaryId = await postFinale(client, g, players, ["a"], winningTunes, {
      duelThreadId: "old-root",
      potSplit: null,
      queueUrl: null,
    });

    expect(summaryId).toBe("status-1");
    const summary = posts[0]!.body as { status: string; in_reply_to_id: string | undefined };
    // NEW thread — no reply to duel thread
    expect(summary.in_reply_to_id).toBeUndefined();
    expect(summary.status).toMatch(/Champion|🏆/i);
    expect(summary.status).toContain("alice");
    expect(summary.status).toMatch(/20/); // final points

    // one post per winning tune, threaded under summary
    expect(posts).toHaveLength(1 + winningTunes.length);
    const tunePost1 = posts[1]!.body as { status: string; in_reply_to_id: string };
    expect(tunePost1.in_reply_to_id).toBe("status-1");
    expect(tunePost1.status).toMatch(/Round 1/);
    expect(tunePost1.status).toContain("https://www.youtube.com/watch?v=aaaaaaaaaaa");

    const tunePost2 = posts[2]!.body as { in_reply_to_id: string };
    expect(tunePost2.in_reply_to_id).toBe("status-1");
  });

  it("shared championship lists both champions", async () => {
    const posts: Posted[] = [];
    const client = mockClient(posts);
    const g = game({ status: "FINALE" });
    const players = [player("a", "alice", 15), player("b", "bob", 15)];
    await postFinale(client, g, players, ["a", "b"], [], { duelThreadId: "x", potSplit: null, queueUrl: null });
    const summary = posts[0]!.body as { status: string };
    expect(summary.status).toContain("alice");
    expect(summary.status).toContain("bob");
    expect(summary.status).toMatch(/tie|shared|co-champion/i);
  });

  it("notes pot split on final-round tie (v1.1 1.3)", async () => {
    const posts: Posted[] = [];
    const client = mockClient(posts);
    const g = game({ status: "FINALE", pot: 0 });
    await postFinale(client, g, [player("a", "alice", 10), player("b", "bob", 10)], ["a", "b"], [], {
      duelThreadId: "x",
      potSplit: { total: 6, each: 3, count: 2 },
      queueUrl: null,
    });
    const summary = posts[0]!.body as { status: string };
    expect(summary.status).toMatch(/split|dividido/i);
    expect(summary.status).toContain("6");
    expect(summary.status).toContain("3");
  });
});

describe("postSideEffect (EXPIRED / FIZZLED / FORFEIT)", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pb-posts-"));
    db = openDatabase(join(dir, "t.db"));
    migrate(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("replies on creation thread with the closure reason", async () => {
    const posts: Posted[] = [];
    const client = mockClient(posts);
    const g = game({ status: "EXPIRED", threadRootId: "root-9" });
    await postSideEffect(client, g, "expired");
    const body = posts[0]!.body as { status: string; in_reply_to_id: string };
    expect(body.in_reply_to_id).toBe("root-9");
    expect(body.status).toMatch(/expired|no.*accept/i);
  });

  it("fizzled message when zero playlists", async () => {
    const posts: Posted[] = [];
    const client = mockClient(posts);
    await postSideEffect(client, game({ status: "FIZZLED" }), "fizzled");
    expect((posts[0]!.body as { status: string }).status).toMatch(/fizzl|no playlists/i);
  });

  it("forfeit closure when player deleted", async () => {
    const posts: Posted[] = [];
    const client = mockClient(posts);
    await postSideEffect(client, game({ status: "FORFEIT" }), "forfeit");
    expect((posts[0]!.body as { status: string }).status).toMatch(/forfeit|closed/i);
  });

  it("asserts 500-char limit on all outbound posts", async () => {
    const posts: Posted[] = [];
    const client = mockClient(posts);
    const huge = game({ theme: "x".repeat(600) });
    await expect(postSideEffect(client, huge, "expired")).rejects.toThrow(/500/);
  });
});
