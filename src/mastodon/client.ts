import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import type { Logger } from "../logger.js";
import {
  createOutboxEffect,
  markOutboxFailed,
  markOutboxSent,
} from "../game/store.js";

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

export class RateLimitError extends Error {
  override readonly name = "RateLimitError";
  readonly resetAt: number;

  constructor(resetAt: number) {
    const safeResetAt = Number.isFinite(resetAt)
      ? resetAt
      : Math.floor(Date.now() / 1000) + 60;
    super(`Mastodon rate limit exhausted; resets at ${new Date(safeResetAt * 1000).toISOString()}`);
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Base delay for exponential backoff between retries (ms). */
const RETRY_BASE_DELAY_MS = 500;

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
    this.maxRetries = opts.maxRetries ?? 2;
    this.db = opts.db;
    this.log = opts.log;
  }

  async get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.request(path, { method: "GET" }, options);
    return (await res.json()) as T;
  }

  async getWithLink<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<{ data: T; linkNext: string | null }> {
    const res = await this.request(path, { method: "GET" }, options);
    const data = (await res.json()) as T;
    const link = res.headers.get("Link");
    let linkNext: string | null = null;
    if (link) {
      const match = link.match(/<([^>]+)>;\s*rel="next"/);
      if (match) linkNext = match[1] ?? null;
    }
    return { data, linkNext };
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
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const method = (init.method ?? "GET").toUpperCase();
    const effectId = method !== "GET"
      ? options.idempotencyKey ?? (this.db ? randomUUID() : null)
      : null;
    if (this.db && effectId) {
      const body = typeof init.body === "string" ? init.body : null;
      createOutboxEffect(this.db, effectId, method as "POST" | "DELETE", url, body);
    }
    const maxRetries = options.maxRetries ?? this.maxRetries;
    let attempt = 0;
    let bypassRateLimit = false;
    const startedAt = Date.now();

    try {
      for (;;) {
        if (!bypassRateLimit) this.assertRateLimit();
        bypassRateLimit = false;

        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...((init.headers as Record<string, string>) ?? {}),
          ...(effectId ? { "Idempotency-Key": effectId } : {}),
        };

        let res: Response;
        try {
          res = await this.fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(15_000) });
        } catch (err) {
          if (attempt < maxRetries) {
            await this.waitBeforeRetry(method, path, attempt, RETRY_BASE_DELAY_MS * 2 ** attempt, {
              reason: "network",
            });
            attempt += 1;
            continue;
          }
          throw err;
        }

        this.trackRateLimit(res);

        if (res.ok) {
          if (this.db && effectId) {
            try {
              markOutboxSent(this.db, effectId);
            } catch {
              // Keep the remote result successful even if ledger persistence fails.
            }
          }
          this.log?.debug(
            {
              method,
              path,
              status: res.status,
              attempt,
              durationMs: Date.now() - startedAt,
            },
            "mastodon request ok",
          );
          return res;
        }

        if (res.status === 429) {
          await safeJson(res);
          // The 429 carries the same headers as a success, and this is the
          // only moment they describe the exhausted bucket. Read them
          // before deciding how long to wait.
          this.trackRateLimit(res);
          const retryAfter = Number(res.headers.get("Retry-After") ?? "60");
          const resetAt = this.rateLimit?.resetAt ??
            (Number.isFinite(retryAfter) ? Math.floor(Date.now() / 1000) + retryAfter : Math.floor(Date.now() / 1000) + 60);
          const resetsAt = new Date(resetAt * 1000).toISOString();
          if (attempt < maxRetries) {
            // Wait out the true window before the one allowed retry. A
            // Retry-After guess could be 1s for a window that resets in
            // minutes, spending another request against that same window.
            await this.waitBeforeRetry(method, path, attempt, Math.max(0, resetAt * 1000 - Date.now()), {
              limit: this.rateLimit?.limit ?? null,
              remaining: this.rateLimit?.remaining ?? null,
              resetsAt,
              reason: "rate_limit",
            });
            attempt += 1;
            bypassRateLimit = true;
            continue;
          }
          this.log?.warn(
            {
              method,
              path,
              limit: this.rateLimit?.limit ?? null,
              remaining: this.rateLimit?.remaining ?? null,
              resetsAt,
              retryAfterHeader: res.headers.get("Retry-After"),
              resetHeader: res.headers.get("X-RateLimit-Reset"),
            },
            "mastodon rate limit exhausted",
          );
          throw new RateLimitError(resetAt);
        }

        if (res.status >= 500 && attempt < maxRetries) {
          await this.waitBeforeRetry(method, path, attempt, RETRY_BASE_DELAY_MS * 2 ** attempt, {
            status: res.status,
            reason: "server_error",
          });
          attempt += 1;
          continue;
        }

        throw new MastodonApiError(res.status, await safeJson(res));
      }
    } catch (err) {
      if (err instanceof RateLimitError) {
        this.log?.warn(
          { method, path, resetAt: err.resetAt, durationMs: Date.now() - startedAt },
          "mastodon rate limit exhausted",
        );
      } else {
        this.log?.error(
          {
            method,
            path,
            attempt,
            durationMs: Date.now() - startedAt,
            err: err instanceof Error ? err.message : String(err),
          },
          "mastodon request failed",
        );
      }
      if (this.db && effectId) {
        const status = err instanceof MastodonApiError && err.status < 500 ? "failed" : "unknown";
        try {
          markOutboxFailed(this.db, effectId, err instanceof Error ? err.message : String(err), status);
        } catch {
          // The pending ledger row remains available for operator inspection.
        }
      }
      throw err;
    }
  }

  /** Log a retry with the backoff being waited out, then sleep for it. */
  private async waitBeforeRetry(
    method: string,
    path: string,
    attempt: number,
    delayMs: number,
    detail: Record<string, unknown>,
  ): Promise<void> {
    this.log?.warn({ method, path, attempt: attempt + 1, delayMs, ...detail }, "mastodon request retry");
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
    if (rl && rl.remaining <= 0 && rl.resetAt * 1000 > Date.now()) {
      throw new RateLimitError(rl.resetAt);
    }
  }
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
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return { error: `HTTP ${res.status}` };
  }
}
