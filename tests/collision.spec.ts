import { describe, it, expect } from "vitest";
import { hasRoundCollision } from "../src/game/types.js";
import type { Tune } from "../src/game/types.js";

/**
 * The bot never creates a poll when both players hold the same video in a
 * round: hasRoundCollision() (src/game/types.ts:125) treats it as a tie and
 * roundState.ts:145 resolves the round without polling. Every driver run
 * finished in seconds with all eight rounds auto_tied, and the driver never
 * had a poll to vote on.
 *
 * These cases pin the rule the driver's tune selection has to satisfy.
 */
type Raw = { accountId: string; videoId: string; position: number };

function tune(accountId: string, videoId: string, position: number): Tune {
  return {
    accountId,
    videoId,
    position,
    url: `https://youtu.be/${videoId}`,
    title: videoId,
  } as Tune;
}

const distinct = [
  tune("host", "aaaaaaa", 1),
  tune("player", "bbbbbbb", 1),
] as Raw[] as Tune[];

const sameVideo = [
  tune("host", "aaaaaaa", 1),
  tune("player", "aaaaaaa", 1),
] as Raw[] as Tune[];

describe("hasRoundCollision", () => {
  it("sees no collision when the players hold different videos", () => {
    expect(hasRoundCollision(distinct, 1)).toBe(false);
  });

  it("sees a collision when both players hold the same video", () => {
    expect(hasRoundCollision(sameVideo, 1)).toBe(true);
  });

  it("ignores collisions in other rounds", () => {
    const round1 = [
      tune("host", "aaaaaaa", 1),
      tune("player", "aaaaaaa", 1),
    ] as Tune[];
    expect(hasRoundCollision(round1, 2)).toBe(false);
  });

  it("detects a collision in a later round too", () => {
    const all = [
      tune("host", "aaaaaaa", 1),
      tune("player", "bbbbbbb", 1),
      tune("host", "ccccccc", 2),
      tune("player", "ccccccc", 2),
    ] as Tune[];
    expect(hasRoundCollision(all, 2)).toBe(true);
  });
});
