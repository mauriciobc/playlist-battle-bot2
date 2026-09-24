import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

/**
 * MASTODON_URL has always been https-only, and that is the right default: a
 * bearer token must not cross a network in clear text. The mock Mastodon
 * listens on http://127.0.0.1, so an exception is needed - but a narrow one.
 *
 * The rule under test: cleartext http is accepted ONLY when the host is a
 * loopback literal AND the mode is not production. A non-loopback http URL
 * stays an error in every mode, so this cannot become a way to ship a
 * token in the clear.
 */

const BASE = {
  MASTODON_TOKEN: "test-token",
  BOT_ACCT: "bot",
  DB_PATH: "/tmp/mock-bot-test.db",
} as const;

function envFor(over: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...BASE, ...over } as NodeJS.ProcessEnv;
}

describe("MASTODON_URL scheme rules", () => {
  it("accepts https in production", () => {
    const cfg = loadConfig(envFor({ MASTODON_URL: "https://mastodon.social" }));
    expect(cfg.mastodonUrl).toBe("https://mastodon.social");
  });

  it("rejects a non-loopback http URL even in test mode", () => {
    expect(() =>
      loadConfig(
        envFor({ MASTODON_URL: "http://mastodon.social", RUN_MODE: "test" }),
      ),
    ).toThrow();
  });

  it("accepts http on 127.0.0.1 in test mode", () => {
    const cfg = loadConfig(
      envFor({ MASTODON_URL: "http://127.0.0.1:54321", RUN_MODE: "test" }),
    );
    expect(cfg.mastodonUrl).toBe("http://127.0.0.1:54321");
  });

  it("accepts http on localhost in test mode", () => {
    const cfg = loadConfig(
      envFor({ MASTODON_URL: "http://localhost:54321", RUN_MODE: "test" }),
    );
    expect(cfg.mastodonUrl).toBe("http://localhost:54321");
  });

  it("rejects loopback http in production, where tokens must not be cleartext", () => {
    expect(() =>
      loadConfig(
        envFor({ MASTODON_URL: "http://127.0.0.1:54321", RUN_MODE: "production" }),
      ),
    ).toThrow();
  });

  it("rejects loopback http when RUN_MODE is unset, defaulting to production", () => {
    expect(() =>
      loadConfig(envFor({ MASTODON_URL: "http://127.0.0.1:54321", RUN_MODE: undefined as unknown as string })),
    ).toThrow();
  });

  it("strips a trailing slash from the accepted loopback URL", () => {
    const cfg = loadConfig(
      envFor({ MASTODON_URL: "http://127.0.0.1:54321/", RUN_MODE: "test" }),
    );
    expect(cfg.mastodonUrl).toBe("http://127.0.0.1:54321");
  });

  it("rejects a cleartext URL that merely looks loopback, such as 127.0.0.1.evil.com", () => {
    expect(() =>
      loadConfig(
        envFor({
          MASTODON_URL: "http://127.0.0.1.evil.com",
          RUN_MODE: "test",
        }),
      ),
    ).toThrow();
  });

  it("rejects a non-loopback private address in test mode", () => {
    // 192.168.x is the homelab, not this process. Cleartext there is the case
    // the https rule exists to prevent.
    expect(() =>
      loadConfig(
        envFor({ MASTODON_URL: "http://192.168.68.104:3000", RUN_MODE: "test" }),
      ),
    ).toThrow();
  });
});
