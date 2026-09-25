import { describe, expect, it } from "vitest";
import {
  eligibleForRound,
  hasRoundCollision,
  isTerminal,
  type GameStatus,
  type Player,
  type Tune,
} from "../src/game/types.js";

function p(id: string, inviteStatus: Player["inviteStatus"] = "accepted"): Player {
  return { accountId: id, acct: id, role: "challenger", inviteStatus, points: 0, joinedAt: null };
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

describe("eligibleForRound (PRD §7)", () => {
  it("non-accepted (pending/declined, incl. withdrawn incomplete playlists) players never play", () => {
    const players = [p("host"), p("x", "pending"), p("y", "declined")];
    const tunes = [t("host", 1, "aaaaaaaaaaa"), t("x", 1, "bbbbbbbbbbb"), t("y", 1, "ccccccccccc")];
    expect(eligibleForRound(players, tunes, 1)).toEqual(["host"]);
  });

  it("excluded set removes a player from eligibility (v1.1 1.4 dead-video)", () => {
    const players = [p("a"), p("b")];
    const tunes = [t("a", 1, "aaaaaaaaaaa"), t("b", 1, "bbbbbbbbbbb")];
    expect(eligibleForRound(players, tunes, 1, new Set(["b"]))).toEqual(["a"]);
    expect(eligibleForRound(players, tunes, 1, new Set())).toEqual(["a", "b"]);
  });

  it("player missing tune #k is not eligible for round k", () => {
    const players = [p("a"), p("b")];
    const tunes = [t("a", 1, "aaaaaaaaaaa"), t("a", 2, "aaaaaaaaaab"), t("b", 1, "bbbbbbbbbbb")];
    expect(eligibleForRound(players, tunes, 2)).toEqual(["a"]);
  });
});

// Same video for several players in a round → automatic tie, no poll (PRD §5.6/§7).
describe("hasRoundCollision", () => {
  it.each([
    ["different videos", [t("a", 1, "aaaaaaaaaaa"), t("b", 1, "bbbbbbbbbbb")], 1, false],
    ["same video", [t("a", 1, "aaaaaaaaaaa"), t("b", 1, "aaaaaaaaaaa")], 1, true],
    ["same video, other round", [t("a", 1, "aaaaaaaaaaa"), t("b", 1, "aaaaaaaaaaa")], 2, false],
    ["same video across different rounds", [t("a", 1, "aaaaaaaaaaa"), t("b", 2, "aaaaaaaaaaa")], 1, false],
    [
      "same video in a later round",
      [t("a", 1, "aaaaaaaaaaa"), t("b", 1, "bbbbbbbbbbb"), t("a", 2, "ccccccccccc"), t("b", 2, "ccccccccccc")],
      2,
      true,
    ],
  ])("%s → %s", (_case, tunes, round, expected) => {
    expect(hasRoundCollision(tunes, round)).toBe(expected);
  });
});

describe("isTerminal", () => {
  it.each<[GameStatus, boolean]>([
    ["CLOSED", true],
    ["EXPIRED", true],
    ["FIZZLED", true],
    ["FORFEIT", true],
    ["CANCELLED", true],
    ["ROUND", false],
    ["COLLECTING", false],
  ])("%s → %s", (status, expected) => {
    expect(isTerminal(status)).toBe(expected);
  });
});
