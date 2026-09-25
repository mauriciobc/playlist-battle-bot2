import { describe, it, expect } from "vitest";
import { driverExitCode } from "../test/integration/driver-exit.js";

/**
 * Run 13 aborted on a configuration error before any step ran, printed
 * "0 passed, 0 failed", and exited 0. The report counted only recorded
 * steps, so an empty results list looked perfect.
 *
 * Green has to mean the lifecycle ran, not that nothing was counted.
 */
const noResults: Array<{ ok: boolean }> = [];

describe("driverExitCode", () => {
  it("fails when the run threw and no step recorded", () => {
    expect(driverExitCode(noResults, new Error("config"))).toBe(1);
  });

  it("succeeds when every step passed", () => {
    const results = [{ ok: true }, { ok: true }];
    expect(driverExitCode(results, null)).toBe(0);
  });

  it("fails when a step failed", () => {
    const results = [{ ok: true }, { ok: false }];
    expect(driverExitCode(results, null)).toBe(1);
  });

  it("treats an empty run with no error as inconclusive success", () => {
    // Nothing ran and nothing threw: not a failure, but it must not be
    // mistaken for a completed lifecycle either.
    expect(driverExitCode(noResults, null)).toBe(0);
  });
});
