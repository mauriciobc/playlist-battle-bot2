import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
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
  private readonly requestTimeoutMs: number;
  private readonly db: Db | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

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
            await this.sleep(this.retryBaseDelayMs * 2 ** attempt);
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
          return res;
        }

        if (res.status === 429) {
          if (attempt < maxRetries) {
            const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
            await this.sleep(Math.max(0, retryAfter * 1000));
            attempt += 1;
            bypassRateLimit = true;
            continue;
          }
          await safeJson(res);
          const retryAfter = Number(res.headers.get("Retry-After") ?? "60");
          const resetAt = this.rateLimit?.resetAt ??
            (Number.isFinite(retryAfter) ? Math.floor(Date.now() / 1000) + retryAfter : Math.floor(Date.now() / 1000) + 60);
          throw new RateLimitError(resetAt);
        }

        if (res.status >= 500 && attempt < maxRetries) {
          await this.sleep(this.retryBaseDelayMs * 2 ** attempt);
          attempt += 1;
          continue;
        }

        throw new MastodonApiError(res.status, await safeJson(res));
      }
    } catch (err) {
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
    const reset = res.headers.get("X-RateLimit-Reset");
    if (limit !== null && remaining !== null && reset !== null) {
      this.rateLimit = {
        limit: Number(limit),
        remaining: Number(remaining),
        resetAt: Number(reset),
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

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return { error: `HTTP ${res.status}` };
  }
}
