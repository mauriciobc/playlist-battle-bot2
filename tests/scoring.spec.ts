import { describe, expect, it } from "vitest";
import {
  awardVotePoints,
  applyPotBonus,
  computeStandings,
  resolveRoundScore,
  splitPotAmong,
  ROUND_QUORUM,
} from "../src/game/scoring.js";
import type { Player } from "../src/game/types.js";

function player(id: string, points = 0): Player {
  return {
    accountId: id,
    acct: id,
    displayName: null,
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
    expect(out.find((p) => p.accountId === "a")?.points).toBe(5);
    expect(out.find((p) => p.accountId === "b")?.points).toBe(3);
    expect(out.find((p) => p.accountId === "c")?.points).toBe(0);
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
  it("clear winner takes the pot (PRD §5.6)", () => {
    const r = resolveRoundScore({
      tallies: [
        { accountId: "a", votes: 7 },
        { accountId: "b", votes: 2 },
        { accountId: "c", votes: 1 },
      ],
      pot: 3,
    });
    expect(r.winnerAccountId).toBe("a");
    expect(r.potAfter).toBe(0);
    expect(r.potAwarded).toBe(3);
  });

  it("2-way tie → no winner, pot += 1 (PRD §5.6)", () => {
    const r = resolveRoundScore({
      tallies: [
        { accountId: "a", votes: 4 },
        { accountId: "b", votes: 4 },
        { accountId: "c", votes: 2 },
      ],
      pot: 5,
    });
    expect(r.winnerAccountId).toBeNull();
    expect(r.potAfter).toBe(6);
    expect(r.potAwarded).toBe(0);
  });

  it("3-way tie → no winner, pot += 1", () => {
    const r = resolveRoundScore({
      tallies: [
        { accountId: "a", votes: 3 },
        { accountId: "b", votes: 3 },
        { accountId: "c", votes: 3 },
      ],
      pot: 0,
    });
    expect(r.winnerAccountId).toBeNull();
    expect(r.potAfter).toBe(1);
  });

  it("all-zero votes → tie, pot += 1", () => {
    const r = resolveRoundScore({
      tallies: [
        { accountId: "a", votes: 0 },
        { accountId: "b", votes: 0 },
      ],
      pot: 2,
    });
    expect(r.winnerAccountId).toBeNull();
    expect(r.potAfter).toBe(3);
  });

  it("quorum: unique leader with empty pot still ties (1–0, pot 0)", () => {
    const r = resolveRoundScore({
      tallies: [
        { accountId: "a", votes: 1 },
        { accountId: "b", votes: 0 },
      ],
      pot: 0,
    });
    expect(r.winnerAccountId).toBeNull();
    expect(r.potAwarded).toBe(0);
    expect(r.potAfter).toBe(1);
  });

  it("quorum: 1–0 → tie, pot +1 (v1.1 1.2)", () => {
    const r = resolveRoundScore({
      tallies: [
        { accountId: "a", votes: 1 },
        { accountId: "b", votes: 0 },
      ],
      pot: 4,
    });
    expect(r.winnerAccountId).toBeNull();
    expect(r.potAfter).toBe(5);
    expect(r.potAwarded).toBe(0);
  });

  it("quorum: 2–0 → tie, pot +1 (total votes < 3)", () => {
    const r = resolveRoundScore({
      tallies: [
        { accountId: "a", votes: 2 },
        { accountId: "b", votes: 0 },
      ],
      pot: 1,
    });
    expect(r.winnerAccountId).toBeNull();
    expect(r.potAfter).toBe(2);
  });

  it("quorum met: 3-vote round with a leader → strict win", () => {
    const r = resolveRoundScore({
      tallies: [
        { accountId: "a", votes: 3 },
        { accountId: "b", votes: 0 },
      ],
      pot: 2,
    });
    expect(r.winnerAccountId).toBe("a");
    expect(r.potAfter).toBe(0);
    expect(r.potAwarded).toBe(2);
  });

  it("0 votes → tie, pot +1 (existing behavior preserved)", () => {
    const r = resolveRoundScore({
      tallies: [
        { accountId: "a", votes: 0 },
        { accountId: "b", votes: 0 },
      ],
      pot: 3,
    });
    expect(r.winnerAccountId).toBeNull();
    expect(r.potAfter).toBe(4);
  });

  it("ROUND_QUORUM is 3", () => {
    expect(ROUND_QUORUM).toBe(3);
  });
});

describe("splitPotAmong (v1.1 1.3)", () => {
  it("divides pot equally among tied players, remainder discarded", () => {
    const out = splitPotAmong([player("a"), player("b"), player("c")], ["a", "b"], 5);
    expect(out.splitEach).toBe(2);
    expect(out.splitTotal).toBe(4);
    expect(out.players.find((p) => p.accountId === "a")?.points).toBe(2);
    expect(out.players.find((p) => p.accountId === "b")?.points).toBe(2);
    expect(out.players.find((p) => p.accountId === "c")?.points).toBe(0);
  });

  it("pot=3, 2-way tie → +1 each", () => {
    const out = splitPotAmong([player("a"), player("b")], ["a", "b"], 3);
    expect(out.splitEach).toBe(1);
    expect(out.splitTotal).toBe(2);
    expect(out.players.every((p) => p.points === 1)).toBe(true);
  });

  it("empty tied list or non-positive pot → no-op", () => {
    expect(splitPotAmong([player("a")], [], 5)).toMatchObject({ splitTotal: 0, splitEach: 0 });
    expect(splitPotAmong([player("a")], ["a"], 0)).toMatchObject({ splitTotal: 0, splitEach: 0 });
    expect(splitPotAmong([player("a")], ["a", "b"], 1)).toMatchObject({ splitTotal: 0, splitEach: 0 });
  });
});

describe("applyPotBonus", () => {
  it("adds pot to winner's points", () => {
    const out = applyPotBonus([player("a", 5), player("b", 9)], "a", 4);
    expect(out.find((p) => p.accountId === "a")?.points).toBe(9);
    expect(out.find((p) => p.accountId === "b")?.points).toBe(9);
  });

  it("no-op when no winner or pot is 0", () => {
    expect(applyPotBonus([player("a", 5)], null, 4)[0]!.points).toBe(5);
    expect(applyPotBonus([player("a", 5)], "a", 0)[0]!.points).toBe(5);
  });
});

describe("computeStandings", () => {
  it("highest points is sole champion", () => {
    const { champions, ordered } = computeStandings([
      player("a", 12),
      player("b", 8),
      player("c", 3),
    ]);
    expect(champions).toEqual(["a"]);
    expect(ordered.map((o) => o.accountId)).toEqual(["a", "b", "c"]);
  });

  it("exact points tie → shared championship (PRD §6)", () => {
    const { champions } = computeStandings([player("a", 10), player("b", 10), player("c", 4)]);
    expect(champions.sort()).toEqual(["a", "b"]);
  });

  it("empty players → no champions", () => {
    expect(computeStandings([]).champions).toEqual([]);
  });
});
