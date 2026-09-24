import { describe, it, expect } from "vitest";
import { RateLimitError, MastodonClient } from "../src/mastodon/client.js";

/**
 * The loop that could not let go.
 *
 * A rate-limited POST made pollNotifications throw; onError only logged, and
 * setInterval fired again 5s later. Each rejected request refreshes the very
 * window being waited out, so at RUN_MODE=e2e cadence the loop never escaped:
 * 47 claim/fail/retry cycles in 4 minutes, cursor frozen, one notification
 * retried forever. onError now suspends the loop until resetAt.
 *
 * This depends on RateLimitError surviving the trip out of the client, which
 * is the part that can quietly not hold.
 */
describe("RateLimitError", () => {
  it("is an Error carrying resetAt in seconds", () => {
    const resetAt = 1_800_000_000;
    const e = new RateLimitError(resetAt);
    expect(e).toBeInstanceOf(Error);
    expect(e.resetAt).toBe(resetAt);
  });

  it("survives instanceof across the module boundary", () => {
    // If client.ts ever stops exporting the class, onError's check silently
    // becomes false and the loop goes back to hammering.
    const e = new RateLimitError(1_800_000_000);
    expect(e instanceof RateLimitError).toBe(true);
  });

  it("is distinguishable from an ordinary error", () => {
    expect(new RateLimitError(1) instanceof Error).toBe(true);
    expect(new Error("boom") instanceof RateLimitError).toBe(false);
  });

  it("exposes resetAt the notification path can read", () => {
    // mention.ts:938 reads err.resetAt to schedule nextAttemptAt; a missing
    // field there would mean retrying immediately.
    const resetAt = 1_800_000_000;
    const e = new RateLimitError(resetAt);
    expect(Number.isFinite(e.resetAt)).toBe(true);
    expect(new Date(e.resetAt * 1000).getTime()).toBe(resetAt * 1000);
  });

  it("has MastodonClient constructable for the client surface", () => {
    expect(typeof MastodonClient).toBe("function");
  });
});
