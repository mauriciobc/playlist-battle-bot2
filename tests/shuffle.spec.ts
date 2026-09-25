import { describe, expect, it } from "vitest";
import { fnv1a, mulberry32, roundSeed, seededShuffle } from "../src/game/shuffle.js";

describe("fnv1a / roundSeed", () => {
  it("returns an unsigned 32-bit integer", () => {
    const h = fnv1a("anything");
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });

  it("roundSeed varies by both gameId and round", () => {
    const base = roundSeed("g-abc", 1);
    expect(roundSeed("g-abc", 2)).not.toBe(base);
    expect(roundSeed("g-abd", 1)).not.toBe(base);
  });
});

describe("mulberry32", () => {
  it("produces values in [0, 1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 100; i += 1) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("seededShuffle (v1.1 1.7)", () => {
  const items = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;

  it("is pure — does not mutate the input array", () => {
    const input = [...items];
    seededShuffle(input, mulberry32(1));
    expect(input).toEqual(items);
  });

  it("returns a permutation (same multiset of elements)", () => {
    const out = seededShuffle(items, mulberry32(roundSeed("g-1", 1)));
    expect([...out].sort()).toEqual([...items].sort());
  });

  it("same seed → same order (deterministic across runs)", () => {
    const r1 = mulberry32(roundSeed("g-xyz", 4));
    const r2 = mulberry32(roundSeed("g-xyz", 4));
    expect(seededShuffle(items, r1)).toEqual(seededShuffle(items, r2));
  });

  it("different (gameId, round) → different order for non-trivial input", () => {
    // Use enough items that a collision of full permutation is vanishingly unlikely.
    const big = Array.from({ length: 16 }, (_, i) => `t${i}`);
    const a = seededShuffle(big, mulberry32(roundSeed("g-1", 1)));
    const b = seededShuffle(big, mulberry32(roundSeed("g-1", 2)));
    const c = seededShuffle(big, mulberry32(roundSeed("g-2", 1)));
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("single-element and empty inputs are stable", () => {
    expect(seededShuffle([], mulberry32(1))).toEqual([]);
    expect(seededShuffle(["only"], mulberry32(1))).toEqual(["only"]);
  });
});
