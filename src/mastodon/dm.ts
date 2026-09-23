import type { Db } from "../db/index.js";
import type { MastodonClient, RequestOptions } from "./client.js";
import { assertPostLength } from "../templates/truncate.js";

/**
 * Mastodon delivers a direct message only when the leading mention is a
 * fully-qualified `@user@instance`. Local accounts report a bare username
 * from the API; remote ones already carry `user@domain`.
 */
function qualifyHandle(handle: string, instanceDomain?: string): string {
  if (!instanceDomain || handle.includes("@")) return handle;
  // Numeric account IDs are not valid mentions — leave them untouched.
  if (/^\d+$/.test(handle)) return handle;
  return `${handle}@${instanceDomain}`;
}

/** DM by mentioning the account with direct visibility. */
export async function dm(
  db: Db,
  client: MastodonClient,
  accountId: string,
  text: string,
  fallbackAcct?: string,
  options: RequestOptions = {},
  instanceDomain?: string,
): Promise<string> {
  const acctRow = db
    .prepare("SELECT acct FROM players WHERE account_id = ?")
    .get(accountId) as { acct: string } | undefined;
  const handle = qualifyHandle(acctRow?.acct ?? fallbackAcct ?? accountId, instanceDomain);
  assertPostLength(text);
  const status = await client.post<{ id: string }>("/api/v1/statuses", {
    status: `@${handle} ${text}`,
    visibility: "direct",
  }, options);
  return status.id;
}
