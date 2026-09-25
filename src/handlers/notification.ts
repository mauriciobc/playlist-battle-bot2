import {
  claimNotification,
  clearNotificationFailure,
  countFailedAttempt,
  markNotificationDeadLettered,
  markNotificationProcessed,
  recordNotificationFailure,
  releaseNotificationClaim,
  resetFailedAttempts,
  type NotificationFailure,
} from "../db/notifications.js";
import { errorMessage } from "../errors.js";
import { ValidationError } from "../game/engine.js";
import { HTTP_TOO_MANY_REQUESTS, MastodonApiError, RateLimitError } from "../mastodon/client.js";
import { classifyNotification, type Classified, type RawNotification } from "../mastodon/notifications.js";
import { fromUnixSeconds } from "../time.js";
import type { HandlerDeps, HandlerResult } from "./deps.js";
import { handleDm } from "./directMessage.js";
import { handlePublicCommand } from "./publicCommand.js";

/** Failed attempts after which a notification is dead-lettered instead of retried. */
const POISON_ATTEMPTS = 3;

/** Mastodon answers worth retrying: a timeout, a rate limit, or a server fault (5xx). */
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_FIRST_SERVER_ERROR = 500;

/** Identifies a notification in the claim table and in every log line about it. */
type NotificationContext = {
  notificationId: string;
  kind: Classified["kind"];
  from: string | undefined;
};

type FailedAttempt = NotificationFailure & { rateLimited: boolean };

export async function processNotification(n: RawNotification, deps: HandlerDeps): Promise<void> {
  const classified = classifyNotification(n, deps.botAcct);
  if (!classified) {
    deps.logger?.debug(
      { notificationId: n.id, type: n.type },
      "notification skipped: not addressed to bot",
    );
    return;
  }

  const context: NotificationContext = {
    notificationId: n.id,
    kind: classified.kind,
    from: "accountAcct" in classified ? classified.accountAcct : undefined,
  };
  if (!claim(deps, context)) return;

  try {
    const result = await handleClassified(classified, deps);
    deps.logger?.info({ ...context, result }, "notification handled");
    recordSuccess(deps, n.id);
  } catch (err) {
    const failure = recordFailure(deps, n.id, err);
    if (failure.deadLetteredAt) return deadLetter(deps, context, failure);
    releaseForRetry(deps, context, failure);
    throw err;
  }
}

/**
 * Claim before handling: an overlapping run sees the row and skips, so one
 * notification can never be handled twice. Released on failure so the next
 * poll retries it — up to POISON_ATTEMPTS times; beyond that the claim is
 * marked terminal ('error') so a permanently failing notification cannot
 * wedge the cursor. Boot clears pending claims left by a crashed process.
 */
function claim(deps: HandlerDeps, context: NotificationContext): boolean {
  const claimed = claimNotification(deps.db, context.notificationId);
  deps.logger?.debug(
    context,
    claimed ? "notification claimed" : "notification skipped: already claimed or processed",
  );
  return claimed;
}

async function handleClassified(classified: Classified, deps: HandlerDeps): Promise<HandlerResult> {
  if (classified.kind === "poll_expired") {
    await deps.onPollExpired?.(classified.statusId);
    return { handled: true, kind: "poll_expired" };
  }
  return classified.kind === "dm" ? handleDm(classified, deps) : handlePublicCommand(classified, deps);
}

function recordSuccess(deps: HandlerDeps, notificationId: string): void {
  clearNotificationFailure(deps.db, notificationId);
  markNotificationProcessed(deps.db, notificationId, deps.now());
}

/**
 * Count the failed attempt and persist it, deciding its fate: non-retryable
 * errors are dead-lettered at once, retryable ones after POISON_ATTEMPTS.
 */
function recordFailure(deps: HandlerDeps, notificationId: string, err: unknown): FailedAttempt {
  const rateLimited = err instanceof RateLimitError ||
    (err instanceof MastodonApiError && err.status === HTTP_TOO_MANY_REQUESTS);
  // A rate limit paces the bot rather than poisoning the notification: it
  // restarts the attempt count instead of adding to it, so it never exhausts it.
  const attempts = rateLimited ? restartAttempts(deps, notificationId) : countFailedAttempt(deps.db, notificationId);
  const attemptsExhausted = !rateLimited && attempts >= POISON_ATTEMPTS;
  const deadLettered = !isRetryable(err) || attemptsExhausted;
  const failure: FailedAttempt = {
    attempts,
    lastError: errorMessage(err),
    nextAttemptAt: err instanceof RateLimitError ? fromUnixSeconds(err.resetAt).toISOString() : null,
    deadLetteredAt: deadLettered ? deps.now().toISOString() : null,
    rateLimited,
  };
  recordNotificationFailure(deps.db, notificationId, failure);
  return failure;
}

/** Forget earlier failed attempts; this one counts as the first. */
function restartAttempts(deps: HandlerDeps, notificationId: string): number {
  resetFailedAttempts(deps.db, notificationId);
  return 1;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof ValidationError) return false;
  if (err instanceof MastodonApiError) {
    return err.status === HTTP_TOO_MANY_REQUESTS ||
      err.status === HTTP_REQUEST_TIMEOUT ||
      err.status >= HTTP_FIRST_SERVER_ERROR;
  }
  return true;
}

function deadLetter(deps: HandlerDeps, context: NotificationContext, failure: FailedAttempt): void {
  markNotificationDeadLettered(deps.db, context.notificationId, failure.attempts);
  deps.logger?.error(
    { ...context, attempts: failure.attempts, err: failure.lastError },
    "notification dead-lettered",
  );
}

function releaseForRetry(deps: HandlerDeps, context: NotificationContext, failure: FailedAttempt): void {
  deps.logger?.warn(
    { ...context, attempts: failure.attempts, rateLimited: failure.rateLimited, err: failure.lastError },
    "notification failed; will retry",
  );
  releaseNotificationClaim(deps.db, context.notificationId);
}
