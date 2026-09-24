import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

/**
 * RUN_MODE controls loop cadence and early close. The bug this replaces:
 * TEST_MODE=1 forced EARLY_CLOSE_MIN_AGE_SEC and EARLY_CLOSE_STAGNATION_SEC
 * to 0, so an operator who set them while TEST_MODE was on got them silently
 * discarded. "e2e" exists because "test" cannot be used to drive the real
 * Mastodon API - rounds resolve before an outside client can vote.
 */
const BASE = {
  MASTODON_URL: "https://mastodon.example",
  MASTODON_TOKEN: "token",
  BOT_ACCT: "playlistbattle",
} as const;

describe("RUN_MODE", () => {
  it("defaults to production when nothing is set", () => {
    const c = loadConfig({ ...BASE });
    expect(c.runMode).toBe("production");
    expect(c.testMode).toBe(false);
  });

  it("keeps the operator's early-close thresholds in e2e mode", () => {
    const c = loadConfig({
      ...BASE,
      RUN_MODE: "e2e",
      EARLY_CLOSE_MIN_AGE_SEC: "60",
      EARLY_CLOSE_STAGNATION_SEC: "60",
    });
    // This is the case that used to silently collapse to 0.
    expect(c.earlyCloseMinAgeSec).toBe(60);
    expect(c.earlyCloseStagnationSec).toBe(60);
    expect(c.testMode).toBe(false);
  });

  it("keeps the operator's early-close thresholds in production", () => {
    const c = loadConfig({
      ...BASE,
      RUN_MODE: "production",
      EARLY_CLOSE_MIN_AGE_SEC: "120",
      EARLY_CLOSE_STAGNATION_SEC: "180",
    });
    expect(c.earlyCloseMinAgeSec).toBe(120);
    expect(c.earlyCloseStagnationSec).toBe(180);
  });

  it("still collapses thresholds to zero in test mode", () => {
    const c = loadConfig({
      ...BASE,
      RUN_MODE: "test",
      EARLY_CLOSE_MIN_AGE_SEC: "60",
      EARLY_CLOSE_STAGNATION_SEC: "60",
    });
    expect(c.earlyCloseMinAgeSec).toBe(0);
    expect(c.earlyCloseStagnationSec).toBe(0);
    expect(c.testMode).toBe(true);
  });

  it("maps TEST_MODE=1 to test mode for existing deployments", () => {
    const c = loadConfig({ ...BASE, TEST_MODE: "1" });
    expect(c.runMode).toBe("test");
    expect(c.testMode).toBe(true);
    expect(c.earlyCloseMinAgeSec).toBe(0);
  });

  it("lets RUN_MODE win over TEST_MODE", () => {
    const c = loadConfig({
      ...BASE,
      TEST_MODE: "1",
      RUN_MODE: "e2e",
      EARLY_CLOSE_MIN_AGE_SEC: "60",
    });
    expect(c.runMode).toBe("e2e");
    expect(c.testMode).toBe(false);
    expect(c.earlyCloseMinAgeSec).toBe(60);
  });

  it("uses fast cadence in test mode and production cadence otherwise", () => {
    const prod = loadConfig({ ...BASE });
    const e2e = loadConfig({ ...BASE, RUN_MODE: "e2e" });
    const test = loadConfig({ ...BASE, RUN_MODE: "test" });

    expect(prod.schedulerIntervalSec).toBeGreaterThan(e2e.schedulerIntervalSec);
    expect(e2e.schedulerIntervalSec).toBeGreaterThanOrEqual(test.schedulerIntervalSec);
  });

  it("rejects an unknown mode loudly", () => {
    expect(() => loadConfig({ ...BASE, RUN_MODE: "turbo" })).toThrow();
  });
});
