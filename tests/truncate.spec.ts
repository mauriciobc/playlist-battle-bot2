import { describe, expect, it } from "vitest";
import { abbreviatePollOption, assertPostLength, dedupePollOptions, POST_LIMIT, sanitizeTitleForPost, truncate } from "../src/templates/truncate.js";

describe("truncate", () => {
  it("keeps text within the limit as-is and cuts longer text to the limit with an ellipsis", () => {
    expect(truncate("Blinding Lights", 25)).toBe("Blinding Lights");
    const out = truncate("A Very Extremely Long Song Title That Goes On And On Forever", 20);
    expect(out).toHaveLength(20);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("abbreviatePollOption", () => {
  it.each([
    ["long title", "Alice", "An Extremely Long Tune Name From The Radio Edit"],
    ["long player name", "VeryLongPlayerNameHere", "Song"],
    ["emoji in title", "Zoë", "🔥 Firework Extravaganza Bonanza Party Mix"],
  ])("fits within 25 chars including player prefix (PRD §2.3): %s", (_case, name, title) => {
    expect(abbreviatePollOption(name, title).length).toBeLessThanOrEqual(25);
  });

  it("includes player name prefix", () => {
    const out = abbreviatePollOption("Bob", "Short");
    expect(out.startsWith("Bob")).toBe(true);
    expect(out).toContain("Short");
  });
});

describe("assertPostLength (PRD §8)", () => {
  it("passes content up to 500 chars and throws beyond", () => {
    expect(() => assertPostLength("x".repeat(POST_LIMIT))).not.toThrow();
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

  it.each([
    [["sam: Official Video", "sam: Official Video"]],
    [["x: y", "x: y", "x: y"]],
  ])("disambiguates duplicates within 25 chars (Mastodon 422 otherwise): %j", (input) => {
    const out = dedupePollOptions(input);
    expect(new Set(out).size).toBe(input.length);
    for (const opt of out) expect(opt.length).toBeLessThanOrEqual(25);
    expect(out[1]).toMatch(/#2$/);
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
  it("breaks URL detection so the canonical link stays the first URL (preview card)", () => {
    expect(sanitizeTitleForPost("Take On Me")).toBe("Take On Me");
    const out = sanitizeTitleForPost("My jam https://evil.example/track remix");
    // no intact https:// sequence left for Mastodon's URL regex to match
    expect(out).not.toContain("https://");
    // human-readable text preserved apart from the invisible separator
    expect(out.replace(/[^ -~]/g, "")).toContain("My jam https:");
  });
});
