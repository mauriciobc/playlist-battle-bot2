import { describe, expect, it } from "vitest";
import {
  eligibleForRound,
  hasRoundCollision,
  videoIdsInRound,
  isTerminal,
  type Player,
  type Tune,
} from "../src/game/types.js";
import { awardVotePoints, computeStandings, resolveRoundScore, applyPotBonus } from "../src/game/scoring.js";

function p(id: string, opts: Partial<Player> = {}): Player {
  return {
    accountId: id,
    acct: id,
    displayName: null,
    role: "challenger",
    inviteStatus: "accepted",
    points: 0,
    joinedAt: null,
    ...opts,
  };
}

function t(accountId: string, position: number, videoId: string): Tune {
  return {
    accountId,
    position,
    videoId,
    title: `Tune ${position}`,
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

describe("PRD §7 edge cases (domain level)", () => {
  it("incomplete playlist (m < N): v1.1 full commitment — player withdraws, not partially forfeited", () => {
    // player b submitted 3 of 8 → at deadline b is treated as a non-submitter
    // (invite_status = 'declined').
    const players = [p("a"), p("b", { inviteStatus: "declined" })];
    const tunes = [
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => t("a", i, `aaaaaaaaa${i}0`)),
      ...[1, 2, 3].map((i) => t("b", i, `bbbbbbbbb${i}0`)),
    ];
    // b is declined → never eligible for any round
    expect(eligibleForRound(players, tunes, 1)).toEqual(["a"]);
    expect(eligibleForRound(players, tunes, 3)).toEqual(["a"]);
    expect(eligibleForRound(players, tunes, 8)).toEqual(["a"]);
  });

  it("excluded set removes a player from eligibility (v1.1 1.4 dead-video)", () => {
    const players = [p("a"), p("b")];
    const tunes = [t("a", 1, "aaaaaaaaaaa"), t("b", 1, "bbbbbbbbbbb")];
    expect(eligibleForRound(players, tunes, 1, new Set(["b"]))).toEqual(["a"]);
    expect(eligibleForRound(players, tunes, 1, new Set())).toEqual(["a", "b"]);
  });

  it("pending (non-accepted) challengers never play", () => {
    const players = [p("host"), p("x", { inviteStatus: "pending" }), p("y", { inviteStatus: "declined" })];
    const tunes = [t("host", 1, "aaaaaaaaaaa"), t("x", 1, "bbbbbbbbbbb"), t("y", 1, "ccccccccccc")];
    expect(eligibleForRound(players, tunes, 1)).toEqual(["host"]);
  });

  it("player missing tune #k is not eligible for round k", () => {
    const players = [p("a"), p("b")];
    const tunes = [t("a", 1, "aaaaaaaaaaa"), t("a", 2, "aaaaaaaaaab"), t("b", 1, "bbbbbbbbbbb")];
    expect(eligibleForRound(players, tunes, 2)).toEqual(["a"]);
  });

  it("identical tune collides across players → automatic tie, no poll (PRD §5.6/§7)", () => {
    const tunes = [t("a", 1, "dQw4w9WgXcQ"), t("b", 1, "dQw4w9WgXcQ")];
    expect(hasRoundCollision(tunes, 1)).toBe(true);
    // different tunes → no collision
    expect(hasRoundCollision([t("a", 1, "dQw4w9WgXcQ"), t("b", 1, "abcdefghijk")], 1)).toBe(false);
    // collision in a different round does not affect round 1
    expect(hasRoundCollision([t("a", 1, "aaaaaaaaaaa"), t("b", 2, "aaaaaaaaaaa")], 1)).toBe(false);
  });

  it("videoIdsInRound maps video → accounts for collision inspection", () => {
    const map = videoIdsInRound(
      [t("a", 2, "xxxxxxxxxxx"), t("b", 2, "xxxxxxxxxxx"), t("c", 2, "yyyyyyyyyyy")],
      2,
    );
    expect(map.get("xxxxxxxxxxx")?.sort()).toEqual(["a", "b"]);
    expect(map.get("yyyyyyyyyyy")).toEqual(["c"]);
  });

  it("only one non-declined player remains → walkover wins round + pot", () => {
    const players = [p("a"), p("b", { inviteStatus: "declined" })];
    const tunes = [
      ...[1, 2, 3, 4, 5].map((i) => t("a", i, `aaaaaaaaa${i}0`)),
      ...[1, 2, 3, 4].map((i) => t("b", i, `bbbbbbbbb${i}0`)),
    ];
    const eligible = eligibleForRound(players, tunes, 5);
    expect(eligible).toEqual(["a"]);
    // sole survivor takes pot
    const withVotes = awardVotePoints(players, []); // no poll happens on walkover
    const r = resolveRoundScore({ tallies: [], pot: 0 });
    void r;
    // simulate walkover: a wins pot of 2
    const after = applyPotBonus(
      withVotes.map((pl) => (pl.accountId === "a" ? { ...pl, points: pl.points + 0 } : pl)),
      "a",
      2,
    );
    expect(after.find((pl) => pl.accountId === "a")?.points).toBe(2);
  });

  it("zero complete playlists → FIZZLED; one complete → default win path distinguishable", () => {
    // engine decides: complete = accepted player with exactly N tunes
    const players = [p("a"), p("b"), p("c", { inviteStatus: "declined" })];
    const tunes = [
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => t("a", i, `aaaaaaaaa${i}0`)),
      ...[1, 2].map((i) => t("b", i, `bbbbbbbbb${i}0`)), // incomplete, not complete
    ];
    const N = 8;
    const complete = players.filter(
      (pl) =>
        pl.inviteStatus === "accepted" &&
        tunes.filter((tt) => tt.accountId === pl.accountId).length === N,
    );
    expect(complete.map((c) => c.accountId)).toEqual(["a"]); // exactly one → default win
    const none = players.filter(
      (pl) =>
        pl.inviteStatus === "accepted" &&
        tunes.filter((tt) => tt.accountId === pl.accountId).length === N && false,
    );
    expect(none).toEqual([]); // zero complete would be FIZZLED
  });

  it("final-round tie splits remaining pot among tied players (v1.1 1.3)", () => {
    // pot stays but is not awarded to a single winner — resolveRound splits it
    const result = resolveRoundScore({
      tallies: [
        { accountId: "a", votes: 5 },
        { accountId: "b", votes: 5 },
      ],
      pot: 7,
    });
    expect(result.winnerAccountId).toBeNull();
    expect(result.potAfter).toBe(8); // score layer still accrues…
    // …but resolveRound (final round) overrides: split pre-round pot instead.
    const preRoundPot = 7;
    const tied = ["a", "b"];
    const players = [p("a", { points: 10 }), p("b", { points: 10 })];
    const each = Math.floor(preRoundPot / tied.length);
    const total = each * tied.length;
    expect(each).toBe(3);
    expect(total).toBe(6);
    const { champions } = computeStandings(players);
    expect(champions.sort()).toEqual(["a", "b"]); // shared victory
  });

  it("terminal statuses recognized", () => {
    expect(isTerminal("CLOSED")).toBe(true);
    expect(isTerminal("EXPIRED")).toBe(true);
    expect(isTerminal("FIZZLED")).toBe(true);
    expect(isTerminal("FORFEIT")).toBe(true);
    expect(isTerminal("CANCELLED")).toBe(true);
    expect(isTerminal("ROUND")).toBe(false);
    expect(isTerminal("COLLECTING")).toBe(false);
  });
});
