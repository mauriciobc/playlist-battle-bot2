import { describe, expect, it } from "vitest";
import {
  awardVotePoints,
  applyPotBonus,
  champions,
  resolveRoundScore,
  splitPotAmong,
} from "../src/game/scoring.js";
import type { Player } from "../src/game/types.js";

function player(id: string, points = 0): Player {
  return {
    accountId: id,
    acct: id,
    role: "challenger",
    inviteStatus: "accepted",
    points,
    joinedAt: null,
  };
}

describe("awardVotePoints", () => {
  it("adds 1 point per vote to each player (PRD §6)", () => {
    const out = awardVotePoints(
      [player("a"), player("b"), player("c")],
      [
        { accountId: "a", votes: 5 },
        { accountId: "b", votes: 3 },
        { accountId: "c", votes: 0 },
      ],
    );
    expect(out.map((p) => p.points)).toEqual([5, 3, 0]);
  });

  it("accumulates across rounds", () => {
    let players = [player("a"), player("b")];
    players = awardVotePoints(players, [{ accountId: "a", votes: 2 }]);
    players = awardVotePoints(players, [{ accountId: "a", votes: 1 }]);
    expect(players[0]!.points).toBe(3);
  });

  it("players with no tallies keep their points", () => {
    const out = awardVotePoints([player("a", 10)], [{ accountId: "b", votes: 4 }]);
    expect(out[0]!.points).toBe(10);
  });
});

describe("resolveRoundScore", () => {
  // votes are for accounts a, b, c in order.
  it.each([
    ["clear winner takes the pot (PRD §5.6)", [7, 2, 1], 3, { winnerAccountId: "a", potAfter: 0, potAwarded: 3 }],
    ["quorum met: 3-vote round with a leader → strict win", [3, 0], 2, { winnerAccountId: "a", potAfter: 0, potAwarded: 2 }],
    ["2-way tie → no winner, pot += 1 (PRD §5.6)", [4, 4, 2], 5, { winnerAccountId: null, potAfter: 6, potAwarded: 0 }],
    ["3-way tie → no winner, pot += 1", [3, 3, 3], 0, { winnerAccountId: null, potAfter: 1, potAwarded: 0 }],
    ["all-zero votes → tie, pot += 1", [0, 0], 2, { winnerAccountId: null, potAfter: 3, potAwarded: 0 }],
    ["quorum: 1–0 → tie, pot += 1 (v1.1 1.2)", [1, 0], 4, { winnerAccountId: null, potAfter: 5, potAwarded: 0 }],
    ["quorum: 2–0 → tie, pot += 1 (total votes < 3)", [2, 0], 1, { winnerAccountId: null, potAfter: 2, potAwarded: 0 }],
  ])("%s", (_case, votes, pot, expected) => {
    const tallies = votes.map((v, i) => ({ accountId: "abc"[i]!, votes: v }));
    expect(resolveRoundScore({ tallies, pot })).toEqual(expected);
  });
});

describe("splitPotAmong (v1.1 1.3)", () => {
  it("divides pot equally among tied players, remainder discarded", () => {
    const out = splitPotAmong([player("a"), player("b"), player("c")], ["a", "b"], 5);
    expect(out.split).toEqual({ total: 4, each: 2, count: 2 });
    expect(out.players.map((p) => p.points)).toEqual([2, 2, 0]);
  });

  it("empty tied list, non-positive pot, or pot smaller than the tie → no-op", () => {
    expect(splitPotAmong([player("a")], [], 5).split).toBeNull();
    expect(splitPotAmong([player("a")], ["a"], 0).split).toBeNull();
    expect(splitPotAmong([player("a")], ["a", "b"], 1).split).toBeNull();
  });
});

describe("applyPotBonus", () => {
  it("adds pot to winner's points", () => {
    const out = applyPotBonus([player("a", 5), player("b", 9)], "a", 4);
    expect(out.map((p) => p.points)).toEqual([9, 9]);
  });

  it("no-op when no winner or pot is 0", () => {
    expect(applyPotBonus([player("a", 5)], null, 4)[0]!.points).toBe(5);
    expect(applyPotBonus([player("a", 5)], "a", 0)[0]!.points).toBe(5);
  });
});

describe("champions", () => {
  it("highest points is sole champion", () => {
    expect(champions([player("a", 12), player("b", 8), player("c", 3)])).toEqual(["a"]);
  });

  it("exact points tie → shared championship (PRD §6)", () => {
    expect(champions([player("b", 10), player("a", 10), player("c", 4)])).toEqual(["a", "b"]);
  });

  it("empty players → no champions", () => {
    expect(champions([])).toEqual([]);
  });
});
