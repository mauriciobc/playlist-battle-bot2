import { describe, it, expect } from "vitest";
import { MastodonClient, RateLimitError } from "../src/mastodon/client.js";

/**
 * Mastodon sends X-RateLimit-Reset as ISO8601, and a 429 carries the limit
 * headers describing the exhausted bucket. The client used Number() on the
 * reset, got NaN, and fell back to now + Retry-After - which is why every
 * backoff advanced by exactly 60s and the bot re-attacked the window.
 *
 * This drives a real MastodonClient over a fake fetch that answers a 429
 * with the headers mastodon.social actually sends, and asserts the thrown
 * error carries the true reset.
 */
function fakeFetch(status: number, headers: Record<string, string>): typeof fetch {
  return (async () => {
    return new Response(JSON.stringify({ error: "Too Many Requests" }), {
      status,
      headers,
    }) as Response;
  }) as typeof fetch;
}

function makeClient(fixture: typeof fetch): MastodonClient {
  return new MastodonClient({
    baseUrl: "https://mastodon.social",
    token: "test",
    fetchImpl: fixture,
    maxRetries: 0,
  } as unknown as ConstructorParameters<typeof MastodonClient>[0]);
}

describe("rate limit parsing", () => {
  it("reads the real reset from an ISO8601 header on a 429", async () => {
    const resetIso = "2026-09-24T14:25:00.000Z";
    const expectedEpoch = Math.floor(Date.parse(resetIso) / 1000);
    const client = makeClient(
      fakeFetch(429, {
        "X-RateLimit-Limit": "1500",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": resetIso,
      }),
    );

    let err: RateLimitError | null = null;
    try {
      await client.post("/api/v1/statuses", { status: "x" });
    } catch (e) {
      err = e as RateLimitError;
    }
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err!.resetAt).toBe(expectedEpoch);
  });

  it("falls back to epoch seconds when a server sends them", async () => {
    const now = Math.floor(Date.now() / 1000);
    const client = makeClient(
      fakeFetch(429, {
        "X-RateLimit-Limit": "300",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(now + 300),
      }),
    );

    let err: RateLimitError | null = null;
    try {
      await client.post("/api/v1/statuses", { status: "x" });
    } catch (e) {
      err = e as RateLimitError;
    }
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err!.resetAt).toBe(now + 300);
  });

  it("still throws even when the reset header is unparseable", async () => {
    const client = makeClient(
      fakeFetch(429, {
        "X-RateLimit-Remaining": "0",
      }),
    );

    let err: RateLimitError | null = null;
    try {
      await client.post("/api/v1/statuses", { status: "x" });
    } catch (e) {
      err = e as RateLimitError;
    }
    expect(err).toBeInstanceOf(RateLimitError);
    expect(Number.isFinite(err!.resetAt)).toBe(true);
  });
});