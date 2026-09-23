import { describe, expect, it } from "vitest";
import { abbreviatePollOption, assertPostLength, dedupePollOptions, POST_LIMIT, sanitizeTitleForPost, truncateTitle } from "../src/templates/truncate.js";

describe("truncateTitle", () => {
  it("keeps short titles as-is", () => {
    expect(truncateTitle("Blinding Lights")).toBe("Blinding Lights");
  });

  it("truncates long titles with ellipsis", () => {
    const out = truncateTitle("A Very Extremely Long Song Title That Goes On And On Forever", 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith("…")).toBe(true);
  });

  it("handles unicode/grapheme-ish input without crashing", () => {
    expect(truncateTitle("🎵🎶 unicode fun 🎸🎤", 10).length).toBeLessThanOrEqual(10);
  });

  it("empty string stays empty", () => {
    expect(truncateTitle("")).toBe("");
  });
});

describe("abbreviatePollOption", () => {
  it("fits within 25 chars including player prefix (PRD §2.3)", () => {
    const out = abbreviatePollOption("Alice", "An Extremely Long Tune Name From The Radio Edit");
    expect(out.length).toBeLessThanOrEqual(25);
  });

  it("includes player name prefix", () => {
    const out = abbreviatePollOption("Bob", "Short");
    expect(out.startsWith("Bob")).toBe(true);
    expect(out).toContain("Short");
  });

  it("handles long player names", () => {
    const out = abbreviatePollOption("VeryLongPlayerNameHere", "Song");
    expect(out.length).toBeLessThanOrEqual(25);
  });

  it("emoji in title does not break limit", () => {
    const out = abbreviatePollOption("Zoë", "🔥 Firework Extravaganza Bonanza Party Mix");
    expect(out.length).toBeLessThanOrEqual(25);
  });
});

describe("assertPostLength", () => {
  it("passes content under 500 chars (PRD §8)", () => {
    expect(() => assertPostLength("hello")).not.toThrow();
    expect(() => assertPostLength("x".repeat(POST_LIMIT))).not.toThrow();
  });

  it("throws for content over 500 chars", () => {
    expect(() => assertPostLength("x".repeat(POST_LIMIT + 1))).toThrow(/500/);
  });
});

describe("dedupePollOptions", () => {
  it("leaves unique options untouched", () => {
    expect(dedupePollOptions(["alice: Take On Me", "bob: Blue Monday"])).toEqual([
      "alice: Take On Me",
      "bob: Blue Monday",
    ]);
  });

  it("disambiguates duplicates within 25 chars (Mastodon 422 otherwise)", () => {
    const out = dedupePollOptions(["sam: Official Video", "sam: Official Video"]);
    expect(out).toHaveLength(2);
    expect(new Set(out).size).toBe(2);
    for (const opt of out) expect(opt.length).toBeLessThanOrEqual(25);
    expect(out[1]).toMatch(/#2$/);
  });

  it("handles three-way collisions", () => {
    const out = dedupePollOptions(["x: y", "x: y", "x: y"]);
    expect(new Set(out).size).toBe(3);
    for (const opt of out) expect(opt.length).toBeLessThanOrEqual(25);
  });

  it("regression: never drops or rearranges options — length must be preserved so optionMap indices stay aligned with vote tallies", () => {
    const inputs = [
      ["a: Same Song", "b: Same Song", "c: Africa"],
      ["x: y", "x: y", "x: y"],
      ["player has a very long display name shown here", "another extremely long display name for testing"],
    ];
    for (const input of inputs) {
      const out = dedupePollOptions(input);
      expect(out).toHaveLength(input.length);
      input.forEach((_, i) => expect(out[i]).toContain(input[i]!.slice(0, 20)));
    }
  });
});

describe("sanitizeTitleForPost", () => {
  it("leaves plain titles unchanged", () => {
    expect(sanitizeTitleForPost("Take On Me")).toBe("Take On Me");
  });

  it("breaks URL detection so the canonical link stays the first URL (preview card)", () => {
    const out = sanitizeTitleForPost("My jam https://evil.example/track remix");
    // no intact https:// sequence left for Mastodon's URL regex to match
    expect(out).not.toContain("https://");
    // human-readable text preserved apart from the invisible separator
    expect(out.replace(/[^ -~]/g, "")).toContain("My jam https:");
  });
});
