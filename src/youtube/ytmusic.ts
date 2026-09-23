import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Minimal authenticated YouTube Music (InnerTube) client — exactly the two
 * writes the finale needs: create a playlist and add videos to it.
 *
 * Authentication is the bot account's browser cookie: `__Secure-3PAPISID` plus
 * a per-request `SAPISIDHASH`. The client context version is derived from
 * today's date the same way the maintained reference client does, so nothing
 * here pins a stale client version.
 *
 * Only the success contract is schema-validated; a write that YouTube answered
 * with a dialog or a failure status is classified into a typed error instead.
 */

const ORIGIN = "https://music.youtube.com";
const BASE_PATH = "/youtubei/v1/";
/** Public WEB_REMIX Innertube key, as sent by the YT Music web client. */
const INNERTUBE_QUERY = "?alt=json&key=AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:88.0) Gecko/20100101 Firefox/88.0";
const SAPISID_COOKIE = "__Secure-3PAPISID";
const SUCCESS = "STATUS_SUCCEEDED";

export type PlaylistPrivacy = "PUBLIC" | "PRIVATE" | "UNLISTED";

export type YtMusicAuth = {
  /** Raw browser cookie header, e.g. `SID=…; __Secure-3PAPISID=…`. */
  cookie: string;
  /** `X-Goog-AuthUser` index, for brand accounts. Defaults to 0. */
  authUser?: number;
};

export type YtMusicErrorKind = "auth" | "gated" | "rejected" | "transport";

/** Every failure carries the operator action it implies (kind) plus the detail. */
export class YtMusicError extends Error {
  override readonly name = "YtMusicError";
  readonly kind: YtMusicErrorKind;

  constructor(kind: YtMusicErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.kind = kind;
  }
}

const writeResponseSchema = z.object({
  status: z.string().optional(),
  playlistId: z.string().optional(),
  error: z.object({ code: z.number().optional(), message: z.string().optional() }).optional(),
});

/**
 * Split a cookie header into pairs. Values may contain `=` (base64 padding,
 * `PREF=tz=…`), so only the first `=` separates — dropping such cookies would
 * silently produce a hash over `undefined` and a bare 401.
 */
function parseCookies(raw: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return cookies;
}

/** `1.YYYYMMDD.01.00` in UTC — the version format YT Music's web client reports. */
function clientVersion(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  return `1.${stamp}.01.00`;
}

/** The `showEngagementPanelEndpoint` dialog tag (captcha, consent, rate limit…), if any. */
function gatedTag(body: unknown): string | null {
  const actions = (body as { actions?: unknown } | null)?.actions;
  if (!Array.isArray(actions)) return null;
  for (const action of actions) {
    const identifier = (
      action as { showEngagementPanelEndpoint?: { identifier?: { tag?: unknown } } } | null
    )?.showEngagementPanelEndpoint?.identifier;
    if (identifier) return typeof identifier.tag === "string" ? identifier.tag : "unknown";
  }
  return null;
}

export type YtMusicPlaylistClientOptions = {
  auth: YtMusicAuth;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

export class YtMusicPlaylistClient {
  private readonly cookies: Map<string, string>;
  private readonly authUser: number;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly sapisid: string;

  constructor(opts: YtMusicPlaylistClientOptions) {
    this.cookies = parseCookies(opts.auth.cookie);
    const sapisid = this.cookies.get(SAPISID_COOKIE);
    if (!sapisid) {
      throw new YtMusicError(
        "auth",
        `YT_COOKIE is missing ${SAPISID_COOKIE} — copy the full request cookie of a logged-in music.youtube.com session`,
      );
    }
    this.sapisid = sapisid;
    this.authUser = opts.auth.authUser ?? 0;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
  }

  /** Creates an empty playlist in the account's library and returns its ID. */
  async createPlaylist(input: {
    title: string;
    description: string;
    privacy: PlaylistPrivacy;
  }): Promise<string> {
    const body = await this.send("playlist/create", {
      title: input.title,
      description: input.description,
      privacyStatus: input.privacy,
    });

    const playlistId = writeResponseSchema.safeParse(body).data?.playlistId;
    if (!playlistId) throw this.rejection("playlist/create", body);
    return playlistId;
  }

  /**
   * Appends `videoIds` in order. YouTube rejects the whole batch when any video
   * is already in the playlist (there is no dedupe option in the default write
   * path), so callers must pass distinct IDs.
   */
  async addTracks(playlistId: string, videoIds: string[]): Promise<void> {
    if (videoIds.length === 0) return;

    const body = await this.send("browse/edit_playlist", {
      playlistId: trimPlaylistIdPrefix(playlistId),
      actions: videoIds.map((videoId) => ({ action: "ACTION_ADD_VIDEO", addedVideoId: videoId })),
    });

    const parsed = writeResponseSchema.safeParse(body).data;
    if (parsed?.status !== SUCCESS) throw this.rejection("browse/edit_playlist", body);
  }

  private async send(path: string, payload: Record<string, unknown>): Promise<unknown> {
    const body = JSON.stringify({
      context: {
        client: { clientName: "WEB_REMIX", clientVersion: clientVersion() },
        user: {},
      },
      ...payload,
    });

    let res: Response;
    try {
      res = await this.fetchImpl(`${ORIGIN}${BASE_PATH}${path}${INNERTUBE_QUERY}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "*/*",
          "accept-language": "en",
          cookie: this.cookieHeader(),
          authorization: this.sapisidHash(),
          origin: ORIGIN,
          "x-origin": ORIGIN,
          "x-goog-authuser": String(this.authUser),
          "user-agent": USER_AGENT,
        },
        body,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      throw new YtMusicError("transport", `${path}: request failed`, { cause: err });
    }

    const text = await res.text();
    if (res.status !== 200) {
      const detail = text.slice(0, 300);
      if (res.status === 401 || res.status === 403) {
        throw new YtMusicError(
          "auth",
          `${path}: HTTP ${res.status} — the YT_COOKIE is expired or belongs to another account: ${detail}`,
        );
      }
      throw new YtMusicError("rejected", `${path}: HTTP ${res.status}: ${detail}`);
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(text);
    } catch (err) {
      throw new YtMusicError("rejected", `${path}: response was not JSON`, { cause: err });
    }

    const tag = gatedTag(parsedBody);
    if (tag) {
      throw new YtMusicError(
        "gated",
        `${path}: YouTube Music asked for '${tag}' interaction instead of performing the write — the account may be restricted`,
      );
    }

    return parsedBody;
  }

  /** The cookie header as configured, so values keep their own `=` characters. */
  private cookieHeader(): string {
    return [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  }

  private sapisidHash(): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = createHash("sha1")
      .update(`${timestamp} ${this.sapisid} ${ORIGIN}`)
      .digest("hex");
    return `SAPISIDHASH ${timestamp}_${digest}`;
  }

  private rejection(path: string, body: unknown): YtMusicError {
    const parsed = writeResponseSchema.safeParse(body).data;
    const message = parsed?.error?.message ?? `status ${parsed?.status ?? "unknown"}`;
    return new YtMusicError("rejected", `${path}: YouTube Music did not perform the write (${message})`);
  }
}

/**
 * YT Music addresses playlists by bare ID for writes; a `VL`-prefixed ID (the
 * form copied from a watch URL) is rejected.
 */
export function trimPlaylistIdPrefix(playlistId: string): string {
  return playlistId.toUpperCase().startsWith("VL") ? playlistId.slice(2) : playlistId;
}
