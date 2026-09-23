import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MastodonClient } from "../src/mastodon/client.js";

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
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    calls = [];
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return jsonResponse({ id: "1", username: "bot" });
    });
    client = new MastodonClient({
      baseUrl: "https://mastodon.example",
      token: "tok",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
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

  it("performs GET by default and JSON-encodes bodies for POST", async () => {
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

  it("retries once on 429 with Retry-After, then succeeds", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ error: "slow down" }, 429, { "Retry-After": "0" }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "2" }));

    const promise = client.get("/api/v1/statuses/1");
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toEqual({ id: "2" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("surfaces exhausted rate limits as RateLimitError", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "slow down" }, 429, { "Retry-After": "120" }),
    );
    await expect(client.get("/api/v1/statuses/1", { maxRetries: 0 })).rejects.toMatchObject({
      name: "RateLimitError",
    });
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
        Link: '<https://mastodon.example/api/v1/notifications?max_id=99>; rel="next"',
      }),
    );
    const { data, linkNext } = await client.getWithLink<Array<{ id: string }>>(
      "/api/v1/notifications",
    );
    expect(data).toEqual([{ id: "1" }]);
    expect(linkNext).toBe("https://mastodon.example/api/v1/notifications?max_id=99");
  });
});
