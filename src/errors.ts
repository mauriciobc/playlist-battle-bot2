/** The message of anything thrown, for logs and internal results. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
