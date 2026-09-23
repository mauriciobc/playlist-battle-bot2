import type { Db } from "../db/index.js";
import type { MastodonClient, RequestOptions } from "./client.js";
import { assertPostLength } from "../templates/truncate.js";

/** DM by mentioning the account with direct visibility. */
export async function dm(
  db: Db,
  client: MastodonClient,
  accountId: string,
  text: string,
  fallbackAcct?: string,
  options: RequestOptions = {},
): Promise<string> {
  const acctRow = db
    .prepare("SELECT acct FROM players WHERE account_id = ?")
    .get(accountId) as { acct: string } | undefined;
  const handle = acctRow?.acct ?? fallbackAcct ?? accountId;
  assertPostLength(text);
  const status = await client.post<{ id: string }>("/api/v1/statuses", {
    status: `@${handle} ${text}`,
    visibility: "direct",
  }, options);
  return status.id;
}
