import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { YtMusicError, YtMusicPlaylistClient } from "../src/youtube/ytmusic.js";

const COOKIE = "SID=abc; __Secure-3PAPISID=AbC/Def+123=";
const SAPISID = "AbC/Def+123=";
const META = { title: "t", description: "d", privacy: "PUBLIC" } as const;

type Captured = { url: string; init: RequestInit };

function respond(body: unknown, status = 200) {
  const calls: Captured[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function jsonBody(call: Captured): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function client(fetchImpl: typeof fetch, authUser = 0): YtMusicPlaylistClient {
  return new YtMusicPlaylistClient({ auth: { cookie: COOKIE, authUser }, fetchImpl });
}

describe("YtMusicPlaylistClient.createPlaylist", () => {
  it("posts the metadata as the YT Music web client, signed and cookie-authenticated, returning the new ID", async () => {
    const { calls, fetchImpl } = respond({ status: "STATUS_SUCCEEDED", playlistId: "PLnew" });

    const playlistId = await client(fetchImpl, 2).createPlaylist({
      title: "Playlist Battle — Ação & Música 🎵",
      description: "Round winners",
      privacy: "UNLISTED",
    });

    expect(playlistId).toBe("PLnew");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(
      "https://music.youtube.com/youtubei/v1/playlist/create?alt=json&key=AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30",
    );
    expect(call.init.method).toBe("POST");
    const body = jsonBody(call);
    expect(body).toMatchObject({
      title: "Playlist Battle — Ação & Música 🎵",
      description: "Round winners",
      privacyStatus: "UNLISTED",
    });

    // Client version is today's date, as the web client reports it.
    const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    expect(body.context).toMatchObject({ client: { clientName: "WEB_REMIX", clientVersion: `1.${today}.01.00` } });

    // SAPISIDHASH over the cookie's own SAPISID value; cookie forwarded verbatim, keeping '=' inside values.
    const headers = call.init.headers as Record<string, string>;
    const [, timestamp, digest] = /^SAPISIDHASH (\d+)_([0-9a-f]{40})$/.exec(headers["authorization"]!) ?? [];
    expect(digest).toBe(createHash("sha1").update(`${timestamp} ${SAPISID} https://music.youtube.com`).digest("hex"));
    expect(headers["cookie"]).toContain(`__Secure-3PAPISID=${SAPISID}`);
    expect(headers["x-goog-authuser"]).toBe("2");
    expect(headers["x-origin"]).toBe("https://music.youtube.com");
  });

  it("rejects a cookie without __Secure-3PAPISID instead of sending a broken hash", () => {
    expect(() => new YtMusicPlaylistClient({ auth: { cookie: "SID=abc" } })).toThrowError(
      expect.objectContaining({ name: "YtMusicError", kind: "auth" }),
    );
  });

  it.each<[string, unknown, number, Record<string, unknown>]>([
    ["an expired session as an auth error", { error: { code: 401 } }, 401, { kind: "auth" }],
    [
      "a dialog response as gated, not as success",
      { actions: [{ showEngagementPanelEndpoint: { identifier: { tag: "captcha" } } }] },
      200,
      { kind: "gated", message: expect.stringContaining("captcha") },
    ],
    [
      "a failure status as rejected",
      { status: "STATUS_FAILED", error: { code: 400, message: "Invalid title" } },
      200,
      { kind: "rejected", message: expect.stringContaining("Invalid title") },
    ],
  ])("classifies %s", async (_case, body, status, expected) => {
    const { fetchImpl } = respond(body, status);
    const err = await client(fetchImpl).createPlaylist(META).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YtMusicError);
    expect(err).toMatchObject(expected);
  });
});

describe("YtMusicPlaylistClient.addTracks", () => {
  it("appends the videos in order, addressing the playlist by bare ID", async () => {
    const { calls, fetchImpl } = respond({ status: "STATUS_SUCCEEDED" });

    await client(fetchImpl).addTracks("VLPLnew", ["vidA", "vidB"]);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/youtubei/v1/browse/edit_playlist");
    expect(jsonBody(calls[0]!)).toMatchObject({
      playlistId: "PLnew",
      actions: [
        { action: "ACTION_ADD_VIDEO", addedVideoId: "vidA" },
        { action: "ACTION_ADD_VIDEO", addedVideoId: "vidB" },
      ],
    });
  });

  it("rejects a batch YouTube refused (duplicate video in the playlist)", async () => {
    const { fetchImpl } = respond({ status: "STATUS_FAILED" });

    await expect(client(fetchImpl).addTracks("PLnew", ["vidA"])).rejects.toMatchObject({
      kind: "rejected",
    });
  });

  it("sends nothing when there are no videos to add", async () => {
    const { calls, fetchImpl } = respond({ status: "STATUS_SUCCEEDED" });

    await client(fetchImpl).addTracks("PLnew", []);

    expect(calls).toHaveLength(0);
  });
});
