/**
 * Interval-loop guard: runs a task at most once concurrently per label.
 * A tick that arrives while the previous one is still in flight is skipped and
 * reported through `onSkip`. The slot is always released — including when the
 * task rejects — so a failing loop cannot wedge itself permanently.
 */

export type LoopRunner = ((label: string, task: () => Promise<unknown>) => void) & {
  drain: () => Promise<void>;
};

export type LoopRunnerOptions = {
  onSkip: (label: string) => void;
  onError: (label: string, err: unknown) => void;
};

export function createLoopRunner(opts: LoopRunnerOptions): LoopRunner {
  const inFlight = new Set<string>();
  const tasks = new Map<string, Promise<void>>();
  const run = (label: string, task: () => Promise<unknown>): void => {
    if (inFlight.has(label)) {
      opts.onSkip(label);
      return;
    }
    inFlight.add(label);
    const promise = task()
      .catch((err: unknown) => opts.onError(label, err))
      .finally(() => {
        inFlight.delete(label);
        tasks.delete(label);
      })
      .then(() => undefined);
    tasks.set(label, promise);
  };
  run.drain = async (): Promise<void> => {
    while (tasks.size > 0) {
      await Promise.allSettled([...tasks.values()]);
    }
  };
  return run;
}
