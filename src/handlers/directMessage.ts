import { latestHostedGameId } from "../db/games.js";
import { m } from "../i18n/index.js";
import { dmAuthor } from "../mastodon/dm.js";
import { CLOSURES, voidOpenGame } from "./closure.js";
import { htmlToText, parseDmReply } from "./commands.js";
import type { CommandInput, HandlerDeps, HandlerResult } from "./deps.js";
import { handleAccept, handleDecline } from "./invite.js";
import { handleLinkSubmission, handleReplace } from "./submission.js";

/** How much of an unrecognized DM the debug log keeps. */
const LOGGED_TEXT_LENGTH = 200;

export async function handleDm(input: CommandInput, deps: HandlerDeps): Promise<HandlerResult> {
  const text = htmlToText(input.content);
  const parsed = parseDmReply(text);

  switch (parsed.kind) {
    case "accept":
      return handleAccept(input, deps);
    case "decline":
      return handleDecline(input, deps);
    case "links":
      return handleLinkSubmission(input, deps, parsed.urls);
    case "cancel":
      return handleCancel(input, deps);
    case "replace":
      return handleReplace(input, deps, parsed);
  }

  deps.logger?.debug(
    { accountId: input.accountId, text: text.slice(0, LOGGED_TEXT_LENGTH) },
    "unrecognized DM text",
  );
  await dmAuthor(deps, input, m().unknownDm(deps.botAcct));
  return { handled: true, kind: "unknown" };
}

/**
 * RULES §4/§6: the host voids an open game by DM — no champion, no pot, scores
 * stay as historical record. `CLOSURES.CANCEL` owns which states may close, so
 * anything else reads as "nothing to cancel".
 */
async function handleCancel(input: CommandInput, deps: HandlerDeps): Promise<HandlerResult> {
  const gameId = latestHostedGameId(deps.db, input.accountId, CLOSURES.CANCEL.from);
  const cancelled = gameId ? await voidOpenGame(deps, gameId, "CANCEL") : null;
  if (cancelled) {
    await dmAuthor(deps, input, m().cancelDone(cancelled.theme));
    return { handled: true, kind: "game_cancelled", detail: cancelled.id };
  }

  await dmAuthor(deps, input, m().cancelNothing());
  return { handled: true, kind: "cancel_rejected", detail: "no cancellable game" };
}
