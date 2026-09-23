import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logger.js";

function capture(): { lines: string[]; destination: { write: (s: string) => void } } {
  const lines: string[] = [];
  return {
    lines,
    destination: {
      write(s: string) {
        lines.push(s);
      },
    },
  };
}

describe("createLogger", () => {
  it("writes JSON lines at the configured level", () => {
    const { lines, destination } = capture();
    const log = createLogger("info", { destination });
    log.info({ gameId: "g-1" }, "hello");
    log.debug("should be filtered");
    const parsed = JSON.parse(lines.join("")) as Record<string, unknown>;
    expect(parsed.msg).toBe("hello");
    expect(parsed.gameId).toBe("g-1");
    expect(lines.join("")).not.toContain("should be filtered");
  });

  it("redacts credential-shaped fields", () => {
    const { lines, destination } = capture();
    const log = createLogger("info", { destination });
    log.info(
      {
        token: "super-secret",
        mastodonToken: "also-secret",
        ytCookie: "__Secure-3PAPISID=cookie",
        headers: { authorization: "Bearer leak" },
      },
      "auth context",
    );
    const text = lines.join("");
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("also-secret");
    expect(text).not.toContain("__Secure-3PAPISID=cookie");
    expect(text).not.toContain("Bearer leak");
    expect(text).toContain("[REDACTED]");
  });

  it("falls back to JSON when pretty is requested without a destination", () => {
    // Under NODE_ENV=test the logger is silent by default; pretty must not throw
    // whether or not pino-pretty is installed.
    const log = createLogger("debug", { pretty: true });
    expect(() => log.info("ok")).not.toThrow();
  });

  it("honors level filtering when a destination is attached", () => {
    const { lines, destination } = capture();
    const log = createLogger("warn", { destination });
    log.info("ignored");
    log.warn("kept");
    const text = lines.join("");
    expect(text).toContain("kept");
    expect(text).not.toContain("ignored");
  });
});
