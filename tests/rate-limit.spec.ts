import { describe, expect, it } from "vitest";
import { RateLimitedError, assertCanCreateGame } from "../src/game/rateLimit.js";

const CFG = { creationCooldownSec: 600, maxGamesPerPlayer: 3 };

describe("assertCanCreateGame (PRD §8)", () => {
  const now = new Date("2026-09-21T12:00:00Z");

  it("allows creation with no history", () => {
    expect(() => assertCanCreateGame(CFG, now, null, [])).not.toThrow();
  });

  it("enforces 10-min creation cooldown", () => {
    const last = "2026-09-21T11:55:00Z"; // 5 min ago
    expect(() => assertCanCreateGame(CFG, now, last, [])).toThrow(RateLimitedError);
    try {
      assertCanCreateGame(CFG, now, last, []);
    } catch (e) {
      expect((e as RateLimitedError).reason).toBe("cooldown");
      expect((e as RateLimitedError).retryAt).toBe("2026-09-21T12:05:00.000Z");
    }
  });

  it("allows creation after cooldown elapsed", () => {
    const last = "2026-09-21T11:45:00Z"; // 15 min ago
    expect(() => assertCanCreateGame(CFG, now, last, [])).not.toThrow();
  });

  it("enforces max concurrent games", () => {
    const openGames = [{ id: "g1" }, { id: "g2" }, { id: "g3" }];
    expect(() => assertCanCreateGame(CFG, now, null, openGames)).toThrow(/active games/);
    try {
      assertCanCreateGame(CFG, now, null, openGames);
    } catch (e) {
      expect((e as RateLimitedError).reason).toBe("concurrent");
    }
  });

  it("under the cap → allowed", () => {
    const openGames = [{ id: "g1" }, { id: "g2" }];
    expect(() => assertCanCreateGame(CFG, now, null, openGames)).not.toThrow();
  });
});
