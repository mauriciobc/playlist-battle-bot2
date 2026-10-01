import { describe, expect, it } from "vitest";
import { abbreviatePollOption, assertPostLength, POST_LIMIT, sanitizeTitleForPost, truncate, tuneLabel } from "../src/templates/truncate.js";

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
    ["long title", "A", "An Extremely Long Tune Name From The Radio Edit"],
    ["emoji in title", "B", "🔥 Firework Extravaganza Bonanza Party Mix"],
    ["empty title", "C", "  "],
  ])("fits within 25 chars including the label prefix (PRD §2.3): %s", (_case, label, title) => {
    const out = abbreviatePollOption(label, title);
    expect(out.length).toBeLessThanOrEqual(25);
    expect(out.startsWith(`${label}: `)).toBe(true);
  });
});

describe("assertPostLength (PRD §8)", () => {
  it("passes content up to 500 chars and throws beyond", () => {
    expect(() => assertPostLength("x".repeat(POST_LIMIT))).not.toThrow();
    expect(() => assertPostLength("x".repeat(POST_LIMIT + 1))).toThrow(/500/);
  });
});

describe("tuneLabel", () => {
  it("counts A…Z then AA, AB… with no repeats", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(tuneLabel)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
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
