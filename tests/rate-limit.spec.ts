import { describe, expect, it } from "vitest";
import { RateLimitedError, assertCanCreateGame } from "../src/game/rateLimit.js";

const CFG = { creationCooldownSec: 600, maxGamesPerPlayer: 3 };
const now = new Date("2026-09-21T12:00:00Z");
const games = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `g${i}` }));

describe("assertCanCreateGame (PRD §8)", () => {
  it.each([
    ["no history", null, 0],
    ["cooldown elapsed (15 min ago)", "2026-09-21T11:45:00Z", 0],
    ["under the concurrent cap", null, 2],
  ])("allows creation: %s", (_case, last, open) => {
    expect(() => assertCanCreateGame(CFG, now, last, games(open))).not.toThrow();
  });

  it("enforces the 10-min creation cooldown, reporting when it ends", () => {
    const last = "2026-09-21T11:55:00Z"; // 5 min ago
    expect(() => assertCanCreateGame(CFG, now, last, [])).toThrow(RateLimitedError);
    expect(() => assertCanCreateGame(CFG, now, last, [])).toThrow("2026-09-21T12:05:00.000Z");
  });

  it("enforces max concurrent games", () => {
    expect(() => assertCanCreateGame(CFG, now, null, games(3))).toThrow(RateLimitedError);
  });
});
