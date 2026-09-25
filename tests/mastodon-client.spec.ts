import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { MastodonClient, RateLimitError } from "../src/mastodon/client.js";
import { openDatabase, migrate, type Db } from "../src/db/index.js";
import type { Logger } from "../src/logger.js";

type FetchCall = { url: string; init: RequestInit | undefined };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("MastodonClient", () => {
  let calls: FetchCall[];
  let client: MastodonClient;
  let fetchMock: Mock;

  function makeClient(extra: { token?: string; log?: Logger; db?: Db } = {}): MastodonClient {
    return new MastodonClient({
      baseUrl: "https://mastodon.example",
      token: "tok",
      fetchImpl: fetchMock as unknown as typeof fetch,
      ...extra,
    });
  }

  beforeEach(() => {
    calls = [];
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ id: "1", username: "bot" });
    });
    client = makeClient();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("sends Authorization bearer header and hits configured base URL", async () => {
    await client.get("/api/v1/accounts/verify_credentials");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://mastodon.example/api/v1/accounts/verify_credentials");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
    expect(headers["Accept"]).toBe("application/json");
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("JSON-encodes bodies for POST", async () => {
    await client.post("/api/v1/statuses", { status: "hi", visibility: "public" });
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ status: "hi", visibility: "public" }));
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends DELETE requests with the bearer header", async () => {
    await client.delete("/api/v1/statuses/1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("DELETE");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
  });

  it("tracks X-RateLimit headers and refuses when exhausted until reset", async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 60;
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: "1" }, 200, {
        "X-RateLimit-Limit": "300",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(resetAt),
      }),
    );
    await client.get("/api/v1/timelines/home");
    expect(client.rateLimit?.remaining).toBe(0);
    expect(client.rateLimit?.limit).toBe(300);

    // remaining is 0 and reset is in the future → next call short-circuits without fetch
    fetchMock.mockClear();
    await expect(client.get("/api/v1/timelines/home")).rejects.toThrow(/rate limit/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a 429 with rate-limit headers instead of failing preflight", async () => {
    vi.useFakeTimers();
    const resetAt = Math.floor(Date.now() / 1000) + 60;
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: "slow down" }, 429, {
          "Retry-After": "0",
          "X-RateLimit-Limit": "300",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(resetAt),
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "2" }));

    const promise = client.get("/api/v1/statuses/1");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ id: "2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries once on 429 with Retry-After, logging the retry without the bearer token", async () => {
    vi.useFakeTimers();
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    client = makeClient({ token: "super-secret-token", log: log as unknown as Logger });
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "slow down" }, 429, { "Retry-After": "0" }))
      .mockResolvedValueOnce(jsonResponse({ id: "2" }));

    const promise = client.get("/api/v1/statuses/1");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ id: "2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "rate_limit", method: "GET" }),
      expect.any(String),
    );
    const serialized = JSON.stringify([log.debug.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
    expect(serialized).not.toContain("super-secret-token");
  });

  it("retries on transient 5xx then throws after max attempts", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    const promise = client.get("/api/v1/statuses/1", { maxRetries: 2 });
    const assertion = expect(promise).rejects.toThrow(/500/);
    await vi.runAllTimersAsync();
    await assertion;
    // initial + 2 retries
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("surfaces exhausted rate limits without reset headers as RateLimitError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "slow down" }, 429, { "Retry-After": "120" }),
    );
    const err = await client.get("/api/v1/statuses/1", { maxRetries: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(Number.isFinite((err as RateLimitError).resetAt)).toBe(true);
  });

  // Mastodon sends X-RateLimit-Reset as ISO8601 (rack_attack's `.iso8601(6)`);
  // Number() on it gave NaN and every backoff fell back to a Retry-After guess.
  it.each([
    ["an ISO8601", "2026-09-24T14:25:00.380888Z", 1_790_259_900],
    ["an epoch-seconds", "1790259900", 1_790_259_900],
  ])("reads the real reset from %s header on a 429", async (_kind, header, expected) => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "Too Many Requests" }, 429, {
        "X-RateLimit-Limit": "1500",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": header,
      }),
    );
    const err = await client.post("/api/v1/statuses", { status: "x" }, { maxRetries: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).resetAt).toBe(expected);
  });

  it("throws MastodonApiError with status and body on 4xx (non-429)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Record not found" }, 404));
    await expect(client.get("/api/v1/statuses/nope")).rejects.toMatchObject({
      name: "MastodonApiError",
      status: 404,
      message: expect.stringContaining("Record not found"),
    });
  });

  it("parses Link header for pagination helpers", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([{ id: "1" }], 200, {
        Link: '<https://mastodon.example/api/v1/notifications?max_id=99>; rel="next", <https://mastodon.example/api/v1/notifications?min_id=120>; rel="prev"',
      }),
    );
    const { data, linkPrev } = await client.getWithLink<Array<{ id: string }>>(
      "/api/v1/notifications",
    );
    expect(data).toEqual([{ id: "1" }]);
    expect(linkPrev).toBe("https://mastodon.example/api/v1/notifications?min_id=120");
  });

  describe("outbox ledger", () => {
    let db: Db;

    beforeEach(() => {
      db = openDatabase(":memory:");
      migrate(db);
      client = makeClient({ db });
    });

    afterEach(() => db.close());

    const effects = (status: string) =>
      db.prepare("SELECT method, path FROM outbox_effects WHERE status = ?").all(status);

    it("records successful POST effects and sends an idempotency key", async () => {
      await client.post("/api/v1/statuses", { status: "hello" });

      expect((calls[0]!.init?.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
      expect(effects("sent")).toMatchObject([
        { method: "POST", path: "https://mastodon.example/api/v1/statuses" },
      ]);
    });

    it("reuses a logical idempotency key without duplicating the ledger row", async () => {
      const options = { idempotencyKey: "pb:v1:test:effect" };

      await client.post("/api/v1/statuses", { status: "hello" }, options);
      await client.post("/api/v1/statuses", { status: "hello" }, options);

      expect(effects("sent")).toHaveLength(1);
      for (const call of calls) {
        expect(call.init?.headers).toMatchObject({ "Idempotency-Key": "pb:v1:test:effect" });
      }
    });

    it("records definite API failures separately from uncertain network outcomes", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad request" }, 400));
      await expect(client.post("/api/v1/statuses", { status: "hello" })).rejects.toThrow();
      expect(effects("failed")).toHaveLength(1);

      fetchMock.mockRejectedValueOnce(new Error("connection reset"));
      await expect(client.post("/api/v1/statuses", { status: "hello" }, { maxRetries: 0 })).rejects.toThrow();
      expect(effects("unknown")).toHaveLength(1);
    });
  });
});
