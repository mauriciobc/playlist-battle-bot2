import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  postRound,
  postRoundResolution,
  postFinale,
  postSideEffect,
  tallyPoll,
} from "../src/mastodon/posts.js";
import type { MastodonClient } from "../src/mastodon/client.js";
import type { Game, Player, Tune } from "../src/game/types.js";
import { m } from "../src/i18n/index.js";

type Posted = { path: string; body: { status: string; in_reply_to_id?: string; poll?: { options: string[]; expires_in: number } } };

function mockClient(posts: Posted[], pollTally?: unknown) {
  return {
    post: vi.fn(async (path: string, body: Posted["body"]) => {
      posts.push({ path, body });
      const id = `status-${posts.length}`;
      // poll posts get a poll object back
      if (body.poll) {
        return { id, poll: { id: `poll-${posts.length}`, expires_at: "2026-09-22T12:00:00.000Z" } };
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
    role: id === "a" ? "host" : "challenger",
    inviteStatus: "accepted",
    points,
    joinedAt: null,
  };
}

function tune(accountId: string, videoId: string, title: string): Tune {
  return {
    accountId,
    position: 1,
    videoId,
    title,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

let posts: Posted[];
let client: MastodonClient;

beforeEach(() => {
  posts = [];
  client = mockClient(posts);
});

describe("postRound (PRD §5.5)", () => {
  it("posts announce → one tune post per player → poll, threaded", async () => {
    const players = [player("a", "alice"), player("b", "bob"), player("c", "carol")];
    const tunes = [
      tune("a", "aaaaaaaaaaa", "Take On Me"),
      tune("b", "bbbbbbbbbbb", "Blue Monday"),
      tune("c", "ccccccccccc", "Africa"),
    ];
    const result = await postRound(client, game(), players, tunes, 1);

    // 1 announce + 3 tunes + 1 poll = 5
    expect(posts.map((p) => p.body.in_reply_to_id)).toEqual(["root-1", "status-1", "status-2", "status-3", "status-4"]);

    // tune posts carry the link for the full embed
    expect(posts[1]!.body.status).toContain("https://www.youtube.com/watch?v=aaaaaaaaaaa");
    expect(posts[1]!.body.status).toContain("Take On Me");

    const poll = posts[4]!.body.poll!;
    expect(poll.expires_in).toBe(86400);
    expect(poll.options).toHaveLength(3); // one per player (PRD §2.2)

    expect(result).toEqual({
      optionMap: { "0": "a", "1": "b", "2": "c" },
      pollId: "poll-5",
      pollStatusId: "status-5",
      pollExpiresAt: "2026-09-22T12:00:00.000Z",
    });
  });

  it("excludes players with no tune this round from the poll (PRD §7)", async () => {
    const players = [player("a", "alice"), { ...player("b", "bob"), inviteStatus: "declined" as const }, player("c", "carol")];
    const tunes = [tune("a", "aaaaaaaaaaa", "Take On Me"), tune("c", "ccccccccccc", "Africa")];
    const result = await postRound(client, game(), players, tunes, 1);
    // announce + 2 tunes + poll
    expect(posts).toHaveLength(4);
    expect(posts[3]!.body.poll!.options).toHaveLength(2);
    expect(Object.values(result.optionMap).sort()).toEqual(["a", "c"]);
  });

  it("keeps poll options unique, ≤25 chars (PRD §2.3), and aligned with optionMap when they collide", async () => {
    // same handle + same title → identical truncated options; Mastodon rejects duplicates with 422
    const players = [player("a", "averyveryverylongplayername"), player("b", "averyveryverylongplayername"), player("c", "carol")];
    const tunes = [
      tune("a", "aaaaaaaaaaa", "An Extremely Long Song Title That Goes On And On Forever"),
      tune("b", "bbbbbbbbbbb", "An Extremely Long Song Title That Goes On And On Forever"),
      tune("c", "ccccccccccc", "Africa"),
    ];
    const result = await postRound(client, game(), players, tunes, 1);

    // dedupePollOptions suffixes rather than drops — indices must stay aligned
    const options = posts.at(-1)!.body.poll!.options;
    expect(options).toHaveLength(3);
    expect(new Set(options).size).toBe(3);
    for (const opt of options) expect(opt.length).toBeLessThanOrEqual(25);
    expect(result.optionMap).toEqual({ "0": "a", "1": "b", "2": "c" });
  });

  it("keeps the round announcement within Mastodon's post limit", async () => {
    const ids = ["a", "b", "c", "d"];
    const players = ids.map((id) => player(id, id.repeat(30)));
    const tunes = ids.map((id) => tune(id, id.repeat(11), id));

    await postRound(client, game({ theme: "x".repeat(120) }), players, tunes, 1);

    expect(posts[0]!.body.status.length).toBeLessThanOrEqual(500);
  });

  it("rejects a poll creation response without a poll id and expiry", async () => {
    const malformed = {
      ...client,
      post: vi.fn(async () => ({ id: "status-without-poll" })),
    } as unknown as MastodonClient;

    await expect(
      postRound(
        malformed,
        game(),
        [player("a", "alice"), player("b", "bob")],
        [tune("a", "aaaaaaaaaaa", "A"), tune("b", "bbbbbbbbbbb", "B")],
        1,
      ),
    ).rejects.toThrow(/valid poll id and expiry/);
  });

  it("keeps the canonical YouTube link as the only detectable URL when a title contains a URL", async () => {
    const players = [player("a", "alice"), player("b", "bob")];
    const tunes = [
      tune("a", "aaaaaaaaaaa", "My jam https://evil.example/track remix"),
      tune("b", "bbbbbbbbbbb", "Blue Monday"),
    ];
    await postRound(client, game(), players, tunes, 1);
    const tunePost = posts[1]!.body.status;
    // Mastodon scans for https:// sequences to pick the preview card URL;
    // exactly one must remain (the canonical embed link).
    expect(tunePost.split("https://")).toHaveLength(2);
    expect(tunePost).toContain("https://www.youtube.com/watch?v=aaaaaaaaaaa");
  });
});

describe("tallyPoll", () => {
  it("maps poll option indices back to accountIds via optionMap", async () => {
    const pollClient = mockClient([], {
      expired: true,
      options: [
        { title: "alice: Take On Me", votes_count: 5 },
        { title: "bob: Blue Monday", votes_count: 3 },
        { title: "carol: Africa", votes_count: 1 },
      ],
    });
    const tallies = await tallyPoll(pollClient, "poll-1", { "0": "a", "1": "b", "2": "c" });
    expect(tallies).toEqual([
      { accountId: "a", votes: 5 },
      { accountId: "b", votes: 3 },
      { accountId: "c", votes: 1 },
    ]);
  });

  it("rejects extra options that are not in the stored map", async () => {
    const pollClient = mockClient([], {
      expired: true,
      options: [
        { title: "x", votes_count: 1 },
        { title: "bob: y", votes_count: 2 },
      ],
    });
    await expect(tallyPoll(pollClient, "p", { "1": "b" })).rejects.toThrow(/do not match/);
  });
});

describe("postRoundResolution (PRD §5.6)", () => {
  it.each([
    [
      "winner and pot bonus",
      { round: 1, winnerAcct: "alice", potAwarded: 2, wasTie: false, newPot: 0 },
      m().resolutionWin(1, "alice", 2),
    ],
    ["tie and pot accrual", { round: 2, winnerAcct: null, potAwarded: 0, wasTie: true, newPot: 4 }, m().resolutionTie(2, 4)],
    [
      "final-round pot split instead of pot accrual (v1.1 1.3)",
      { round: 8, winnerAcct: null, potAwarded: 0, wasTie: true, newPot: 0, potSplit: { total: 6, each: 3, count: 2 } },
      m().resolutionFinalTie(8, 6, 3),
    ],
  ])("announces %s on the duel thread", async (_case, input, expected) => {
    await postRoundResolution(client, game({ pot: 0 }), [player("a", "alice", 9), player("b", "bob", 4)], input);
    expect(posts[0]!.body.status).toContain(expected);
    expect(posts[0]!.body.in_reply_to_id).toBe("root-1");
  });
});

describe("postFinale (PRD §5.7)", () => {
  const opts = { duelThreadId: "x", potSplit: null, queueUrl: null };

  it("creates NEW thread: summary first, then one post per winning tune", async () => {
    const players = [player("a", "alice", 20), player("b", "bob", 11)];
    const winningTunes = [
      { round: 1, ...tune("a", "aaaaaaaaaaa", "Take On Me") },
      { round: 3, ...tune("b", "bbbbbbbbbbb", "Blue Monday") },
    ];

    const summaryId = await postFinale(client, game({ status: "FINALE" }), players, ["a"], winningTunes, opts);

    expect(summaryId).toBe("status-1");
    // NEW thread — no reply to duel thread; tune posts threaded under the summary
    expect(posts.map((p) => p.body.in_reply_to_id)).toEqual([undefined, "status-1", "status-1"]);
    expect(posts[0]!.body.status).toContain(m().champion("@alice"));
    expect(posts[1]!.body.status).toContain("https://www.youtube.com/watch?v=aaaaaaaaaaa");
  });

  it("shared championship lists both champions", async () => {
    const players = [player("a", "alice", 15), player("b", "bob", 15)];
    await postFinale(client, game({ status: "FINALE" }), players, ["a", "b"], [], opts);
    expect(posts[0]!.body.status).toContain(m().sharedChampionship("@alice & @bob"));
  });

  it("notes pot split on final-round tie (v1.1 1.3)", async () => {
    const players = [player("a", "alice", 10), player("b", "bob", 10)];
    await postFinale(client, game({ status: "FINALE", pot: 0 }), players, ["a", "b"], [], {
      ...opts,
      potSplit: { total: 6, each: 3, count: 2 },
    });
    expect(posts[0]!.body.status).toContain(m().finalePotSplit(6, 3, 2));
  });
});

describe("postSideEffect (EXPIRED / FIZZLED / FORFEIT)", () => {
  it.each([
    ["expired", m().sideExpired],
    ["fizzled", m().sideFizzled],
    ["forfeit", m().sideForfeit],
  ] as const)("replies %s closure reason on the creation thread", async (kind, copy) => {
    await postSideEffect(client, game({ threadRootId: "root-9" }), kind);
    expect(posts[0]!.body).toMatchObject({ in_reply_to_id: "root-9", status: copy("80s Synth") });
  });

  it("asserts 500-char limit on all outbound posts", async () => {
    await expect(postSideEffect(client, game({ theme: "x".repeat(600) }), "expired")).rejects.toThrow(/500/);
  });
});
