import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import { createOutboxEffect, markOutboxFailed, markOutboxSent, type OutboxMethod } from "../db/outbox.js";
import { errorMessage } from "../errors.js";
import { fromUnixSeconds, MS_PER_SECOND, toUnixSeconds } from "../time.js";
import type { Logger } from "../logger.js";

export class MastodonApiError extends Error {
  override readonly name = "MastodonApiError";
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    const msg =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${status}`;
    super(`Mastodon API error ${status}: ${msg}`);
    this.status = status;
    this.body = body;
  }
}

export const HTTP_TOO_MANY_REQUESTS = 429;

/** Assumed rate-limit window when Mastodon gives no usable reset time. */
const DEFAULT_RATE_LIMIT_WINDOW_SEC = 60;

const nowSec = () => toUnixSeconds(Date.now());

export class RateLimitError extends Error {
  override readonly name = "RateLimitError";
  readonly resetAt: number;

  constructor(resetAt: number) {
    const safeResetAt = Number.isFinite(resetAt) ? resetAt : nowSec() + DEFAULT_RATE_LIMIT_WINDOW_SEC;
    super(`Mastodon rate limit exhausted; resets at ${fromUnixSeconds(safeResetAt).toISOString()}`);
    this.resetAt = safeResetAt;
  }
}

type RateLimitState = {
  limit: number;
  remaining: number;
  resetAt: number; // unix seconds
};

type MastodonClientOptions = {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  db?: Db;
  /** Optional structured logger for live debugging (never logs credentials). */
  log?: Logger;
};

export type RequestOptions = {
  maxRetries?: number;
  idempotencyKey?: string;
};

/** One logical request across its retries. */
type RequestAttempt = {
  method: string;
  path: string;
  url: string;
  startedAt: number;
  /** Retries so far (0 on the first try). */
  retries: number;
};

const DEFAULT_MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 15_000;
/** Base delay for exponential backoff between retries. */
const RETRY_BASE_DELAY_MS = 500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const backoffMs = (retries: number) => RETRY_BASE_DELAY_MS * 2 ** retries;

export class MastodonClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly db: Db | undefined;
  private readonly log: Logger | undefined;

  rateLimit: RateLimitState | null = null;

  constructor(opts: MastodonClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.db = opts.db;
    this.log = opts.log;
  }

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.request(path, { method: "GET" }, options);
    return (await res.json()) as T;
  }

  /** GET plus the Link header's rel="prev" URL — the next-newer page when paging forward with min_id. */
  async getWithLink<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<{ data: T; linkPrev: string | null }> {
    const res = await this.request(path, { method: "GET" }, options);
    const data = (await res.json()) as T;
    return { data, linkPrev: prevPageLink(res.headers.get("Link")) };
  }

  async post<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    const res = await this.request(path, init, options);
    return (await res.json()) as T;
  }

  async delete<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.request(path, { method: "DELETE" }, options);
    return (await res.json()) as T;
  }

  private async request(
    path: string,
    init: RequestInit,
    options: RequestOptions,
  ): Promise<Response> {
    const attempt: RequestAttempt = {
      method: (init.method ?? "GET").toUpperCase(),
      path,
      url: path.startsWith("http") ? path : `${this.baseUrl}${path}`,
      startedAt: Date.now(),
      retries: 0,
    };
    const effectId = this.openOutboxEffect(attempt, init, options.idempotencyKey);

    try {
      const res = await this.sendWithRetries(attempt, init, effectId, options.maxRetries ?? this.maxRetries);
      this.settleOutboxEffect(effectId, (db, id) => markOutboxSent(db, id));
      this.log?.debug(
        {
          method: attempt.method,
          path,
          status: res.status,
          attempt: attempt.retries,
          durationMs: Date.now() - attempt.startedAt,
        },
        "mastodon request ok",
      );
      return res;
    } catch (err) {
      this.logFailure(attempt, err);
      const status = err instanceof MastodonApiError && err.status < 500 ? "failed" : "unknown";
      this.settleOutboxEffect(effectId, (db, id) => markOutboxFailed(db, id, errorMessage(err), status));
      throw err;
    }
  }

  /**
   * Send until a success, a non-retryable failure, or the retry budget runs
   * out. Network errors and 5xx back off exponentially; a 429 waits out the
   * window Mastodon reports.
   */
  private async sendWithRetries(
    attempt: RequestAttempt,
    init: RequestInit,
    effectId: string | null,
    maxRetries: number,
  ): Promise<Response> {
    let waitedOutRateLimit = false;
    for (;; attempt.retries += 1) {
      if (!waitedOutRateLimit) this.assertRateLimit();
      waitedOutRateLimit = false;
      const canRetry = attempt.retries < maxRetries;

      let res: Response;
      try {
        res = await this.fetchImpl(attempt.url, {
          ...init,
          headers: this.headers(init, effectId),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        if (!canRetry) throw err;
        await this.waitBeforeRetry(attempt, backoffMs(attempt.retries), { reason: "network" });
        continue;
      }

      this.trackRateLimit(res);
      if (res.ok) return res;

      if (res.status === HTTP_TOO_MANY_REQUESTS) {
        await safeJson(res);
        const resetAt = this.rateLimitResetAt(res);
        const resetsAt = fromUnixSeconds(resetAt).toISOString();
        if (!canRetry) {
          this.logRateLimitExhausted(attempt, res, resetsAt);
          throw new RateLimitError(resetAt);
        }
        // Wait out the true window before the one allowed retry. A
        // Retry-After guess could be 1s for a window that resets in
        // minutes, spending another request against that same window.
        await this.waitBeforeRetry(attempt, Math.max(0, resetAt * MS_PER_SECOND - Date.now()), {
          limit: this.rateLimit?.limit ?? null,
          remaining: this.rateLimit?.remaining ?? null,
          resetsAt,
          reason: "rate_limit",
        });
        waitedOutRateLimit = true;
        continue;
      }

      if (res.status >= 500 && canRetry) {
        await this.waitBeforeRetry(attempt, backoffMs(attempt.retries), {
          status: res.status,
          reason: "server_error",
        });
        continue;
      }

      throw new MastodonApiError(res.status, await safeJson(res));
    }
  }

  private headers(init: RequestInit, effectId: string | null): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
      ...(effectId ? { "Idempotency-Key": effectId } : {}),
    };
  }

  /**
   * The idempotency key of a write (null for a read), recorded as a pending
   * effect in the outbox ledger when one is configured.
   */
  private openOutboxEffect(attempt: RequestAttempt, init: RequestInit, idempotencyKey?: string): string | null {
    if (attempt.method === "GET") return null;
    const effectId = idempotencyKey ?? (this.db ? randomUUID() : null);
    if (this.db && effectId) {
      const body = typeof init.body === "string" ? init.body : null;
      createOutboxEffect(this.db, effectId, attempt.method as OutboxMethod, attempt.url, body);
    }
    return effectId;
  }

  /**
   * Record the request's outcome in the ledger. Ledger failures are swallowed:
   * they must not change the request's own outcome, and the pending row stays
   * available for operator inspection.
   */
  private settleOutboxEffect(effectId: string | null, settle: (db: Db, id: string) => void): void {
    if (!this.db || !effectId) return;
    try {
      settle(this.db, effectId);
    } catch {
      // See above: the request outcome wins over ledger bookkeeping.
    }
  }

  /**
   * A 429 carries the same X-RateLimit headers as a success (already tracked),
   * and they describe the exhausted bucket; Retry-After is only the fallback.
   */
  private rateLimitResetAt(res: Response): number {
    if (this.rateLimit) return this.rateLimit.resetAt;
    const retryAfter = Number(res.headers.get("Retry-After") ?? DEFAULT_RATE_LIMIT_WINDOW_SEC);
    return nowSec() + (Number.isFinite(retryAfter) ? retryAfter : DEFAULT_RATE_LIMIT_WINDOW_SEC);
  }

  private logRateLimitExhausted(attempt: RequestAttempt, res: Response, resetsAt: string): void {
    this.log?.warn(
      {
        method: attempt.method,
        path: attempt.path,
        limit: this.rateLimit?.limit ?? null,
        remaining: this.rateLimit?.remaining ?? null,
        resetsAt,
        retryAfterHeader: res.headers.get("Retry-After"),
        resetHeader: res.headers.get("X-RateLimit-Reset"),
      },
      "mastodon rate limit exhausted",
    );
  }

  private logFailure(attempt: RequestAttempt, err: unknown): void {
    const { method, path } = attempt;
    const durationMs = Date.now() - attempt.startedAt;
    if (err instanceof RateLimitError) {
      this.log?.warn({ method, path, resetAt: err.resetAt, durationMs }, "mastodon rate limit exhausted");
      return;
    }
    this.log?.error(
      { method, path, attempt: attempt.retries, durationMs, err: errorMessage(err) },
      "mastodon request failed",
    );
  }

  /** Log a retry with the backoff being waited out, then sleep for it. */
  private async waitBeforeRetry(
    attempt: RequestAttempt,
    delayMs: number,
    detail: Record<string, unknown>,
  ): Promise<void> {
    this.log?.warn(
      { method: attempt.method, path: attempt.path, attempt: attempt.retries + 1, delayMs, ...detail },
      "mastodon request retry",
    );
    await sleep(delayMs);
  }

  private trackRateLimit(res: Response): void {
    const limit = res.headers.get("X-RateLimit-Limit");
    const remaining = res.headers.get("X-RateLimit-Remaining");
    const resetAt = parseResetAt(res.headers.get("X-RateLimit-Reset"));
    if (limit !== null && remaining !== null && resetAt !== null) {
      this.rateLimit = {
        limit: Number(limit),
        remaining: Number(remaining),
        resetAt,
      };
    }
  }

  private assertRateLimit(): void {
    const rl = this.rateLimit;
    if (rl && rl.remaining <= 0 && rl.resetAt * MS_PER_SECOND > Date.now()) {
      throw new RateLimitError(rl.resetAt);
    }
  }
}

/** The rel="prev" URL of a Link header, if any. */
function prevPageLink(link: string | null): string | null {
  return link?.match(/<([^>]+)>;\s*rel="prev"/)?.[1] ?? null;
}

/**
 * Mastodon sends X-RateLimit-Reset as ISO8601: rack_attack.rb's
 * throttled_responder writes `.iso8601(6)`, and a live header from
 * mastodon.social reads 2026-09-24T14:25:00.380888Z. Number() on that is
 * NaN, so rateLimit.resetAt was NaN, assertRateLimit's `resetAt * 1000 >
 * Date.now()` was never true, and every backoff fell through to the
 * Retry-After guess - which is why the logged reset advanced by exactly
 * 60s on each attempt. Accept epoch seconds as well.
 */
function parseResetAt(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) return asNumber;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? toUnixSeconds(parsed) : null;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return { error: `HTTP ${res.status}` };
  }
}
