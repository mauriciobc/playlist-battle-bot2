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

export type RateLimitState = {
  limit: number;
  remaining: number;
  resetAt: number; // unix seconds
};

export type MastodonClientOptions = {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Base delay for exponential backoff between retries (ms). */
  retryBaseDelayMs?: number;
  maxRetries?: number;
  requestTimeoutMs?: number;
  db?: Db;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Optional structured logger for live debugging (never logs credentials). */
  log?: Logger;
};

export type RequestOptions = {
  maxRetries?: number;
  idempotencyKey?: string;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class MastodonClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetries: number;
  private   readonly requestTimeoutMs: number;
  private readonly db: Db | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: Logger | undefined;

  rateLimit: RateLimitState | null = null;

  constructor(opts: MastodonClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 500;
    this.maxRetries = opts.maxRetries ?? 2;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.db = opts.db;
    this.sleep = opts.sleepImpl ?? defaultSleep;
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
          const merged: RequestInit = {
            ...init,
            headers,
            signal: init.signal ?? AbortSignal.timeout(this.requestTimeoutMs),
          };
          res = await this.fetchImpl(url, merged);
        } catch (err) {
          if (attempt < maxRetries) {
            const delayMs = this.retryBaseDelayMs * 2 ** attempt;
            this.log?.warn(
              { method, path, attempt: attempt + 1, delayMs, reason: "network" },
              "mastodon request retry",
            );
            await this.sleep(delayMs);
            attempt += 1;
            continue;
          }
          throw err;
        }

        this.trackRateLimit(res);

        if (res.ok) {
          if (this.db && effectId) {
            try {
              markOutboxSent(this.db, effectId, null);
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
          this.log?.warn(
            {
              method,
              path,
              limit: this.rateLimit?.limit ?? null,
              remaining: this.rateLimit?.remaining ?? null,
              resetsAt: new Date(resetAt * 1000).toISOString(),
              retryAfterHeader: res.headers.get("Retry-After"),
              resetHeader: res.headers.get("X-RateLimit-Reset"),
            },
            "mastodon rate limit exhausted",
          );
          throw new RateLimitError(resetAt);
        }

        if (res.status >= 500 && attempt < maxRetries) {
          const delayMs = this.retryBaseDelayMs * 2 ** attempt;
          this.log?.warn(
            { method, path, status: res.status, attempt: attempt + 1, delayMs, reason: "server_error" },
            "mastodon request retry",
          );
          await this.sleep(delayMs);
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
