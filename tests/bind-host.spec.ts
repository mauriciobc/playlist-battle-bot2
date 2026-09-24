import { describe, it, expect } from "vitest";
import { MockMastodonServer } from "../test/integration/mock-mastodon.js";

/**
 * The bot normally runs in Docker, where 127.0.0.1 is the container's own
 * loopback and cannot reach a process listening on the host. The mock has to
 * be able to bind 0.0.0.0 so the harness can hand the bot a reachable origin,
 * while the driver inside this process keeps using loopback.
 */
describe("MockMastodonServer bind address", () => {
  it("defaults to loopback so a stray run is not exposed to the LAN", async () => {
    const server = new MockMastodonServer({
      botAcct: "bot@mock.social",
      hostAcct: "host@mock.social",
      playerAcct: "player@mock.social",
    });
    await server.start();
    // baseUrl is what callers use; it stays loopback-addressable.
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await server.stop();
  });

  it("exposes the port the listener actually bound", async () => {
    // Reaching 127.0.0.1 proves nothing about the bind address - 0.0.0.0
    // answers there too. Assert the reported port, which is what a
    // containerised bot is handed as its origin.
    const server = new MockMastodonServer({
      botAcct: "bot@mock.social",
      hostAcct: "host@mock.social",
      playerAcct: "player@mock.social",
      host: "0.0.0.0",
    });
    await server.start();
    const port = Number(new URL(server.baseUrl).port);
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(0);
    expect(server.port).toBe(port);
    await server.stop();
  });
});
