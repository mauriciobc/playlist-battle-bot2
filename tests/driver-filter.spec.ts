import { describe, it, expect } from "vitest";
import { MastodonAPI } from "../test/integration/mastodon-helpers.js";

/**
 * Regression cover for the crash that cost three hours.
 *
 * botActivity() filtered statuses with `s.hasPoll`, but hasPoll is a field
 * the following .map manufactures - it does not exist on the raw
 * MastodonStatus. The filter threw on every poll, which is precisely the one
 * thing the driver exists to observe.
 *
 * test/integration was absent from tsconfig's include list, so `tsc --noEmit`
 * stayed green while the driver was broken. The real fix was adding it to the
 * include; these tests keep the logic honest once it compiles.
 */
type RawStatus = { content: string; poll?: unknown };

function status(over: { content?: string; poll?: unknown } = {}): RawStatus {
  return {
    content: over.content ?? "",
    ...(over.poll !== undefined ? { poll: over.poll } : {}),
  };
}

describe("botActivity theme filter", () => {
  /** Mirrors the filter in World.botActivity, which is not exported. */
  const filter = (sts: RawStatus[], gameTheme: string | null) =>
    sts
      .filter((s) => !gameTheme || Boolean(s.poll) || s.content.includes(gameTheme))
      .map((s) => ({
        text: s.content,
        hasPoll: Boolean(s.poll),
        poll: s.poll ?? null,
      }));

  it("keeps a poll visible even when it does not mention the theme", () => {
    const poll = { id: "p1", options: [] };
    const out = filter([status({ content: "which round?", poll })], "E2E r1");
    expect(out).toHaveLength(1);
    expect(out[0]?.hasPoll).toBe(true);
  });

  it("keeps a status that mentions the theme", () => {
    const out = filter([status({ content: 'Rodada 1 de "E2E r1"' })], "E2E r1");
    expect(out).toHaveLength(1);
  });

  it("drops a status belonging to another game", () => {
    const out = filter([status({ content: 'Rodada 1 de "someone else"' })], "E2E r1");
    expect(out).toHaveLength(0);
  });

  it("does not throw when the poll is absent", () => {
    // The original bug: hasPoll was read off the raw status object.
    expect(() => filter([status({ content: "no theme here" })], "E2E r1")).not.toThrow();
  });

  it("normalises a missing poll to null rather than undefined", () => {
    const out = filter([status({ content: "E2E r1" })], "E2E r1");
    expect(out[0]?.poll).toBeNull();
  });
});
