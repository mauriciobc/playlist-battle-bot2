import { describe, expect, it, vi } from "vitest";
import { openDatabase, migrate } from "../src/db/index.js";
import { listOutboxEffects } from "../src/game/store.js";
import { MastodonClient } from "../src/mastodon/client.js";

function harness(fetchImpl: typeof fetch) {
  const db = openDatabase(":memory:");
  migrate(db);
  const client = new MastodonClient({
    baseUrl: "https://mastodon.example",
    token: "token",
    db,
    fetchImpl,
  });
  return { db, client };
}

describe("Mastodon outbox ledger", () => {
  it("records successful POST effects and sends an idempotency key", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
      return new Response(JSON.stringify({ id: "status-1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const { db, client } = harness(fetchImpl);

    await client.post("/api/v1/statuses", { status: "hello" });

    expect(listOutboxEffects(db, "sent")).toMatchObject([
      { method: "POST", path: "https://mastodon.example/api/v1/statuses" },
    ]);
    db.close();
  });

  it("reuses a logical idempotency key without duplicating the ledger row", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "status-1" }), { status: 200 })) as unknown as typeof fetch;
    const { db, client } = harness(fetchImpl);
    const options = { idempotencyKey: "pb:v1:test:effect" };

    await client.post("/api/v1/statuses", { status: "hello" }, options);
    await client.post("/api/v1/statuses", { status: "hello" }, options);

    expect(listOutboxEffects(db, "sent")).toHaveLength(1);
    const calls = (fetchImpl as unknown as {
      mock: { calls: [string | URL | Request, RequestInit | undefined][] };
    }).mock.calls;
    expect(calls[0]?.[1]?.headers).toMatchObject({ "Idempotency-Key": "pb:v1:test:effect" });
    expect(calls[1]?.[1]?.headers).toMatchObject({ "Idempotency-Key": "pb:v1:test:effect" });
    db.close();
  });

  it("records definite API failures separately from uncertain network outcomes", async () => {
    const apiFailure = harness(
      vi.fn(async () => new Response(JSON.stringify({ error: "bad request" }), { status: 400 })) as unknown as typeof fetch,
    );
    await expect(apiFailure.client.post("/api/v1/statuses", { status: "hello" })).rejects.toThrow();
    expect(listOutboxEffects(apiFailure.db, "failed")).toHaveLength(1);
    apiFailure.db.close();

    const networkFailure = harness(
      vi.fn(async () => {
        throw new Error("connection reset");
      }) as unknown as typeof fetch,
    );
    await expect(
      networkFailure.client.post("/api/v1/statuses", { status: "hello" }, { maxRetries: 0 }),
    ).rejects.toThrow();
    expect(listOutboxEffects(networkFailure.db, "unknown")).toHaveLength(1);
    networkFailure.db.close();
  });
});
