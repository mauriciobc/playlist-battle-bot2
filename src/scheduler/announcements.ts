import type { HandlerDeps } from "../handlers/deps.js";
import {
  dueAnnouncements,
  markAnnouncementFailed,
  markAnnouncementSent,
  type Announcement,
} from "../db/announcements.js";
import { awardedBadges, awardsForGame } from "../db/merit.js";
import { MastodonApiError } from "../mastodon/client.js";
import { dmBadges } from "../mastodon/dm.js";
import { postBadges } from "../mastodon/posts.js";
import { errorMessage } from "../errors.js";
import { exclusively } from "./claims.js";

/**
 * Delivers the merit announcements queued by the finale.
 *
 * Each row is independent: a player with DMs closed cannot hold back the
 * thread reply or anyone else's message, and none of it can keep a game open —
 * the finale closes the game and only enqueues. Failures retry with backoff up
 * to `announceMaxAttempts`; a refusal a retry cannot fix is abandoned at once.
 * Abandoned rows are logged, never silent, and the badge itself stays recorded
 * (`@bot badges` still shows it).
 */

const DRAIN_CLAIM = "merit:announcements";
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR = 500;

/** Delay before the next try, after `failedAttempts` failures: 1m, 2m, 4m … capped. */
export function announcementBackoffMs(failedAttempts: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failedAttempts - 1));
}

/** A client-side refusal that retrying the same request cannot turn into a success. */
function isPermanent(err: unknown): boolean {
  return (
    err instanceof MastodonApiError &&
    err.status >= 400 &&
    err.status < HTTP_SERVER_ERROR &&
    err.status !== HTTP_REQUEST_TIMEOUT &&
    err.status !== HTTP_TOO_MANY_REQUESTS
  );
}

/** Deliver one row. Returns false when the row turned out to have nothing to say. */
async function deliver(handler: HandlerDeps, row: Announcement): Promise<boolean> {
  const awards = awardsForGame(handler.db, row.gameId);
  if (row.kind === "thread") {
    if (awards.length === 0 || row.replyToId === null) return false;
    await postBadges(handler.client, awards, row.replyToId, row.gameId);
    return true;
  }
  const award = awards.find((a) => a.accountId === row.accountId);
  if (!award) return false;
  await dmBadges(handler, {
    gameId: row.gameId,
    accountId: award.accountId,
    acct: award.acct,
    badges: award.badges,
    heldTotal: awardedBadges(handler.db, award.accountId).size,
  });
  return true;
}

/**
 * Attempt every delivery due now (one game's, when `gameId` is given).
 * Never throws: a failure is recorded on its row. Returns how many were sent.
 */
export async function drainAnnouncements(handler: HandlerDeps, gameId?: string): Promise<number> {
  let sent = 0;
  await exclusively(DRAIN_CLAIM, async () => {
    for (const row of dueAnnouncements(handler.db, handler.now(), gameId)) {
      const at = handler.now();
      try {
        const delivered = await deliver(handler, row);
        markAnnouncementSent(handler.db, row, at);
        if (delivered) sent += 1;
      } catch (err) {
        const attempts = row.attempts + 1;
        const giveUp = isPermanent(err) || attempts >= handler.announceMaxAttempts;
        const retryAt = giveUp ? null : new Date(at.getTime() + announcementBackoffMs(attempts));
        markAnnouncementFailed(handler.db, row, errorMessage(err), retryAt, at);
        const detail = { gameId: row.gameId, kind: row.kind, accountId: row.accountId, attempts, err: errorMessage(err) };
        if (giveUp) {
          handler.logger?.warn(detail, "merit announcement abandoned; the badge stays recorded");
        } else {
          handler.logger?.info({ ...detail, retryAt: retryAt!.toISOString() }, "merit announcement failed; will retry");
        }
      }
    }
  });
  return sent;
}
