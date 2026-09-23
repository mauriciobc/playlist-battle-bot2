import { describe, expect, it } from "vitest";
import { fnv1a, mulberry32, roundSeed, seededShuffle } from "../src/game/shuffle.js";

describe("fnv1a", () => {
  it("is deterministic for the same input", () => {
    expect(fnv1a("game-1:1")).toBe(fnv1a("game-1:1"));
  });

  it("differs for different inputs", () => {
    expect(fnv1a("game-1:1")).not.toBe(fnv1a("game-1:2"));
    expect(fnv1a("game-1:1")).not.toBe(fnv1a("game-2:1"));
  });

  it("returns an unsigned 32-bit integer", () => {
    const h = fnv1a("anything");
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("roundSeed", () => {
  it("is stable for the same (gameId, round)", () => {
    expect(roundSeed("g-abc", 3)).toBe(roundSeed("g-abc", 3));
  });

  it("varies by both gameId and round", () => {
    const base = roundSeed("g-abc", 1);
    expect(roundSeed("g-abc", 2)).not.toBe(base);
    expect(roundSeed("g-abd", 1)).not.toBe(base);
  });
});

describe("mulberry32", () => {
  it("produces the same sequence for the same seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).toEqual(seqB);
  });

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
    const copy = [...input];
    seededShuffle(input, mulberry32(1));
    expect(input).toEqual(copy);
  });

  it("returns a permutation (same multiset of elements)", () => {
    const out = seededShuffle(items, mulberry32(roundSeed("g-1", 1)));
    expect([...out].sort()).toEqual([...items].sort());
    expect(out).toHaveLength(items.length);
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

  it("two elements are swapped or kept per seed (always a valid permutation)", () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const out = seededShuffle(["x", "y"], mulberry32(seed));
      expect([...out].sort()).toEqual(["x", "y"]);
    }
  });
});
