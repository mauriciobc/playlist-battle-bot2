import type { Db } from "../db/index.js";
import { playerAcct } from "../db/players.js";
import type { MastodonClient, RequestOptions } from "./client.js";
import { mention } from "./handle.js";
import { assertPostLength, truncate } from "../templates/truncate.js";
import { m } from "../i18n/index.js";
import type { BadgeId } from "../game/merit.js";

export type DmDeps = { db: Db; client: MastodonClient; instanceDomain?: string };

/** DM by mentioning the account with direct visibility. */
export async function dm(
  deps: DmDeps,
  accountId: string,
  text: string,
  fallbackAcct?: string,
  options: RequestOptions = {},
): Promise<string> {
  const handle = mention(playerAcct(deps.db, accountId) ?? fallbackAcct ?? accountId, deps.instanceDomain);
  assertPostLength(text);
  const status = await deps.client.post<{ id: string }>("/api/v1/statuses", {
    status: `${handle} ${text}`,
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

/**
 * The private half of an award: what was unlocked, and the running total.
 *
 * The public thread reply carries the flex; this carries the detail a 500-char
 * post cannot, plus the player's standing. A DM has no network effect, so it
 * supplements the thread and never replaces it.
 */
export async function dmBadges(
  deps: DmDeps,
  input: { gameId: string; accountId: string; acct: string; badges: readonly BadgeId[]; heldTotal: number },
): Promise<string> {
  const lines = input.badges.map((b) => m().badgeListLine(m().badgeName(b)));
  const text = truncate(
    [m().badgeDmHeader(input.badges.length), ...lines, m().badgeDmTotal(input.heldTotal)].join("\n"),
  );
  // Keyed per game and player: a resumed finale re-enters this loop, and a DM
  // has no other way to tell the server it was already sent.
  return dm(deps, input.accountId, text, input.acct, {
    idempotencyKey: `pb:v1:merit:${input.gameId}:dm:${input.accountId}`,
  });
}
