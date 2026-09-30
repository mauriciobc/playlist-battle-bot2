import { describe, expect, it } from "vitest";
import {
  bestWinStreak,
  earnedBadges,
  instanceOf,
  rankBoard,
  shouldPublishBoard,
  winCount,
  type BoardEntry,
  type CareerInput,
  type DuelRecord,
} from "../src/game/merit.js";

function duel(id: string, wasChampion: boolean, closedAt = "2026-01-01T00:00:00.000Z"): DuelRecord {
  return { gameId: id, closedAt, wasChampion };
}

function career(over: Partial<CareerInput> = {}): CareerInput {
  return {
    accountId: "a",
    duels: [],
    hostedCount: 0,
    remoteInstances: new Set<string>(),
    opponentCount: 0,
    completedFullPlaylist: false,
    playedToFinalRound: false,
    ...over,
  };
}

describe("instanceOf", () => {
  it("reads the domain off a federated handle, lowercased", () => {
    expect(instanceOf("alice@Other.Social")).toBe("other.social");
  });

  it("is null for a local account", () => {
    expect(instanceOf("alice")).toBeNull();
  });

  it("is null for a leading @ with no domain", () => {
    expect(instanceOf("@alice")).toBeNull();
  });
});

describe("winCount", () => {
  it("counts a shared crown as a win", () => {
    expect(winCount([duel("g1", true), duel("g2", true), duel("g3", false)])).toBe(2);
  });

  it("is zero with no duels", () => {
    expect(winCount([])).toBe(0);
  });
});

describe("bestWinStreak", () => {
  it("counts consecutive wins, breaking on a loss", () => {
    // Input order is deliberately reversed; ordering is by closedAt.
    const duels = [
      duel("g3", false, "2026-03-03T00:00:00.000Z"),
      duel("g2", true, "2026-03-02T00:00:00.000Z"),
      duel("g1", true, "2026-03-01T00:00:00.000Z"),
    ];
    expect(bestWinStreak(duels)).toBe(2);
  });

  it("is the longest run anywhere in the history, not just the recent one", () => {
    const duels = [
      duel("g1", true, "2026-01-01T00:00:00.000Z"),
      duel("g2", true, "2026-01-02T00:00:00.000Z"),
      duel("g3", true, "2026-01-03T00:00:00.000Z"),
      duel("g4", false, "2026-01-04T00:00:00.000Z"),
      duel("g5", true, "2026-01-05T00:00:00.000Z"),
    ];
    expect(bestWinStreak(duels)).toBe(3);
  });

  it("is not broken by duels the account did not play", () => {
    // A gap in the calendar is a break in play, not a loss: the account simply
    // has no record of those dates, and the streak survives.
    const duels = [
      duel("g1", true, "2026-01-01T00:00:00.000Z"),
      duel("g2", true, "2026-02-01T00:00:00.000Z"),
      duel("g3", true, "2026-03-01T00:00:00.000Z"),
    ];
    expect(bestWinStreak(duels)).toBe(3);
  });

  it("orders deterministically when two duels closed in the same tick", () => {
    const same = "2026-01-01T00:00:00.000Z";
    const a = bestWinStreak([duel("ga", true, same), duel("gb", true, same)]);
    const b = bestWinStreak([duel("gb", true, same), duel("ga", true, same)]);
    expect(a).toBe(b);
  });

  it("is zero for a player who never won", () => {
    expect(bestWinStreak([duel("g1", false), duel("g2", false)])).toBe(0);
  });
});

describe("earnedBadges", () => {
  it("awards nothing to an account with no duels", () => {
    expect(earnedBadges(career())).toEqual([]);
  });

  it("awards debut on a first duel, even a lost one", () => {
    expect(earnedBadges(career({ duels: [duel("g1", false)] }))).toEqual(["debut"]);
  });

  it("stacks first_blood over debut for a first win", () => {
    const got = earnedBadges(career({ duels: [duel("g1", true)] }));
    expect(got).toContain("debut");
    expect(got).toContain("first_blood");
  });

  it("awards participation tiers at their exact counts", () => {
    const five = earnedBadges(career({ duels: Array.from({ length: 5 }, (_, i) => duel(`g${i}`, false)) }));
    expect(five).toContain("plays_5");
    expect(five).not.toContain("plays_25");

    const twentyFive = earnedBadges(
      career({ duels: Array.from({ length: 25 }, (_, i) => duel(`g${i}`, false)) }),
    );
    expect(twentyFive).toContain("plays_25");
  });

  it("awards a streak badge on exactly the threshold and keeps it after a later loss", () => {
    const three = Array.from({ length: 3 }, (_, i) => duel(`g${i}`, true));
    expect(earnedBadges(career({ duels: three }))).toContain("hat_trick");

    // A loss afterwards does not retract the high-water mark.
    const laterLoss = [...three, duel("g3", false, "2026-02-01T00:00:00.000Z")];
    expect(earnedBadges(career({ duels: laterLoss }))).toContain("hat_trick");
  });

  it("does not award a streak badge one short of the threshold", () => {
    const two = [duel("g1", true), duel("g2", true)];
    expect(earnedBadges(career({ duels: two }))).not.toContain("hat_trick");
  });

  it("does not build a streak across a loss in the middle", () => {
    const duels = [duel("g1", true), duel("g2", false), duel("g3", true)];
    expect(earnedBadges(career({ duels }))).not.toContain("hat_trick");
  });

  it("awards first_contact from one met instance and wanderer from three", () => {
    expect(earnedBadges(career({ duels: [duel("g1", true)], remoteInstances: new Set(["a.social"]) }))).toContain(
      "first_contact",
    );
    const three = earnedBadges(
      career({ duels: [duel("g1", true)], remoteInstances: new Set(["a.social", "b.social", "c.social"]) }),
    );
    expect(three).toContain("wanderer");
  });

  it("awards durable only at ten distinct opponents", () => {
    const base = { duels: [duel("g1", true)] };
    expect(earnedBadges(career({ ...base, opponentCount: 9 }))).not.toContain("durable");
    expect(earnedBadges(career({ ...base, opponentCount: 10 }))).toContain("durable");
  });

  it("awards conductor on the first hosted duel and promoter at ten", () => {
    expect(earnedBadges(career({ duels: [duel("g1", true)], hostedCount: 1 }))).toContain("conductor");
    expect(earnedBadges(career({ duels: [duel("g1", true)], hostedCount: 10 }))).toContain("promoter");
  });

  it("awards nothing for a host that never actually played a closed duel", () => {
    expect(earnedBadges(career({ hostedCount: 10 }))).toEqual([]);
  });

  it("is idempotent — the same career yields the same badges", () => {
    const c = career({ duels: [duel("g1", true), duel("g2", true), duel("g3", true)], hostedCount: 1 });
    expect(earnedBadges(c)).toEqual(earnedBadges(c));
  });
});

describe("rankBoard", () => {
  const entries: BoardEntry[] = [
    { accountId: "c", acct: "c", wins: 9, duels: 11 },
    { accountId: "a", acct: "a", wins: 1, duels: 1 },
    { accountId: "b", acct: "b", wins: 9, duels: 12 },
  ];

  it("ranks by wins, best first", () => {
    expect(rankBoard(entries, "wins").map((e) => e.accountId)).toEqual(["b", "c", "a"]);
  });

  it("ranks by duels when asked", () => {
    expect(rankBoard(entries, "duels").map((e) => e.accountId)).toEqual(["b", "c", "a"]);
  });

  it("breaks ties by account id, stably across runs", () => {
    const forward = rankBoard(entries, "wins").map((e) => e.accountId);
    const reversed = rankBoard([...entries].reverse(), "wins").map((e) => e.accountId);
    expect(forward).toEqual(reversed);
  });

  it("applies the participation floor to duels, not to the ranked score", () => {
    // "a" has 1 win; gating on wins would let it qualify, gating on duels does not.
    const ranked = rankBoard(entries, "wins", 3).map((e) => e.accountId);
    expect(ranked).toEqual(["b", "c"]);
    expect(ranked).not.toContain("a");
  });

  it("keeps a low-duel entry on the duels board, where duels is the score", () => {
    expect(rankBoard(entries, "duels", 3).map((e) => e.accountId)).not.toContain("a");
    expect(rankBoard(entries, "duels", 1).map((e) => e.accountId)).toContain("a");
  });

  it("returns nothing for an empty pool", () => {
    expect(rankBoard([], "wins")).toEqual([]);
  });
});

describe("shouldPublishBoard", () => {
  it("publishes with enough activity", () => {
    expect(shouldPublishBoard({ closedDuels: 2, distinctPlayers: 3 })).toBe(true);
  });

  it("stays silent on a quiet week", () => {
    expect(shouldPublishBoard({ closedDuels: 1, distinctPlayers: 5 })).toBe(false);
    expect(shouldPublishBoard({ closedDuels: 9, distinctPlayers: 2 })).toBe(false);
    expect(shouldPublishBoard({ closedDuels: 0, distinctPlayers: 0 })).toBe(false);
  });
});
