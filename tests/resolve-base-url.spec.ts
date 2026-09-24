import { describe, it, expect } from "vitest";
import { resolveBaseUrl } from "../test/integration/mastodon-helpers.js";

/**
 * The driver hardcoded `https://${cfg.hostInstance}`, so pointing it at the
 * mock Mastodon would have sent it to https://mock.social - a real DNS
 * lookup, not the mock listening on 127.0.0.1. An explicit URL override has
 * to win, and it has to work for plain hosts too so the same code path
 * serves the live runs.
 */
describe("resolveBaseUrl", () => {
  it("returns the plain https origin for a bare host name", () => {
    expect(resolveBaseUrl(undefined, "mastodon.social")).toBe("https://mastodon.social");
  });

  it("falls back to mastodon.social when the host is blank too", () => {
    // The driver already defaults HOST_INSTANCE; this covers a blank value
    // reaching here, so the origin is never "https://".
    expect(resolveBaseUrl(undefined, undefined)).toBe("https://mastodon.social");
    expect(resolveBaseUrl("   ", "  ")).toBe("https://mastodon.social");
  });

  it("uses an explicit http:// URL verbatim, for the local mock", () => {
    expect(resolveBaseUrl("http://127.0.0.1:54321", "mock.social")).toBe(
      "http://127.0.0.1:54321",
    );
  });

  it("strips a trailing slash so paths do not double up", () => {
    expect(resolveBaseUrl("http://127.0.0.1:54321/", "mock.social")).toBe(
      "http://127.0.0.1:54321",
    );
  });

  it("keeps a full https URL when one is given", () => {
    expect(resolveBaseUrl("https://ursal.zone", "mastodon.social")).toBe(
      "https://ursal.zone",
    );
  });

  it("ignores an empty override and falls back to the host", () => {
    expect(resolveBaseUrl("", "ursal.zone")).toBe("https://ursal.zone");
  });
});
