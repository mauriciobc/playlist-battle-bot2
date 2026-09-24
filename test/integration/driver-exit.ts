/**
 * Exit code for an integration lifecycle run.
 *
 * A run that threw is a failure even when no step recorded one. Run 13
 * aborted on a configuration error, printed "0 passed, 0 failed" and exited
 * 0 - a green exit code for a run that never started. Exiting on the count of
 * recorded steps alone means an empty results list looks perfect.
 *
 * Extracted from driver.ts so it can be tested without booting the harness.
 */
export function driverExitCode(
  results: ReadonlyArray<{ ok: boolean }>,
  fatal: unknown,
): number {
  return results.some((r) => !r.ok) || fatal ? 1 : 0;
}
