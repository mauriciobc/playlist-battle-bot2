import type { Db } from "../db/index.js";
import { playerAcct } from "../db/players.js";
import type { MastodonClient, RequestOptions } from "./client.js";
import { assertPostLength } from "../templates/truncate.js";

export type DmDeps = { db: Db; client: MastodonClient; instanceDomain?: string };

/** Numeric account IDs are not valid mentions. */
const ACCOUNT_ID_PATTERN = /^\d+$/;

/**
 * Mastodon delivers a direct message only when the leading mention is a
 * fully-qualified `@user@instance`. Local accounts report a bare username
 * from the API; remote ones already carry `user@domain`.
 */
function qualifyHandle(handle: string, instanceDomain?: string): string {
  if (!instanceDomain || handle.includes("@")) return handle;
  if (ACCOUNT_ID_PATTERN.test(handle)) return handle;
  return `${handle}@${instanceDomain}`;
}

/** DM by mentioning the account with direct visibility. */
export async function dm(
  deps: DmDeps,
  accountId: string,
  text: string,
  fallbackAcct?: string,
  options: RequestOptions = {},
): Promise<string> {
  const handle = qualifyHandle(playerAcct(deps.db, accountId) ?? fallbackAcct ?? accountId, deps.instanceDomain);
  assertPostLength(text);
  const status = await deps.client.post<{ id: string }>("/api/v1/statuses", {
    status: `@${handle} ${text}`,
    visibility: "direct",
  }, options);
  return status.id;
}

/** DM the author of a command; their own handle addresses them until they play in a game. */
export function dmAuthor(
  deps: DmDeps,
  author: { accountId: string; accountAcct: string },
  text: string,
): Promise<string> {
  return dm(deps, author.accountId, text, author.accountAcct);
}
