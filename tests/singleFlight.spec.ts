import { describe, expect, it, vi } from "vitest";
import { createLoopRunner } from "../src/singleFlight.js";

/** Yields to the macrotask queue so promise continuations settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness() {
  const skipped: string[] = [];
  const errors: string[] = [];
  const run = createLoopRunner({
    onSkip: (label) => skipped.push(label),
    onError: (label) => errors.push(label),
  });
  return { run, skipped, errors };
}

describe("createLoopRunner", () => {
  it("skips a tick that arrives while the previous one is still running", async () => {
    const { run, skipped } = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = vi.fn(async () => {
      await gate;
    });

    run("polls", task);
    run("polls", task);

    expect(task).toHaveBeenCalledTimes(1);
    expect(skipped).toEqual(["polls"]);

    release();
    await settle();
  });

  it("runs the same loop again once the previous tick settles", async () => {
    const { run, skipped } = harness();
    const task = vi.fn(async () => {});

    run("polls", task);
    await settle();
    run("polls", task);
    await settle();

    expect(task).toHaveBeenCalledTimes(2);
    expect(skipped).toEqual([]);
  });

  it("releases the slot when a tick rejects, and reports the error", async () => {
    const { run, skipped, errors } = harness();
    const failure = new Error("network blip");
    const task = vi.fn(async () => {
      throw failure;
    });

    run("polls", task);
    await settle();
    run("polls", task);
    await settle();

    expect(task).toHaveBeenCalledTimes(2); // a failing loop is not wedged
    expect(skipped).toEqual([]);
    expect(errors).toEqual(["polls", "polls"]);
  });

  it("waits for in-flight work when draining", async () => {
    const { run } = harness();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    run("polls", async () => {
      await gate;
      finished = true;
    });

    const drained = run.drain();
    expect(finished).toBe(false);
    release();
    await drained;
    expect(finished).toBe(true);
  });

  it("runs different loops concurrently", async () => {
    const { run, skipped } = harness();
    const task = vi.fn(async () => {});

    run("polls", task);
    run("notifications", task);
    await settle();

    expect(task).toHaveBeenCalledTimes(2);
    expect(skipped).toEqual([]);
  });
});
