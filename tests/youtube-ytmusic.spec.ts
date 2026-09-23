import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { YtMusicError, YtMusicPlaylistClient } from "../src/youtube/ytmusic.js";

const COOKIE = "SID=abc; __Secure-3PAPISID=AbC/Def+123=";
const SAPISID = "AbC/Def+123=";

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

function client(fetchImpl: typeof fetch, authUser?: number): YtMusicPlaylistClient {
  return new YtMusicPlaylistClient({
    auth: authUser === undefined ? { cookie: COOKIE } : { cookie: COOKIE, authUser },
    fetchImpl,
  });
}

describe("YtMusicPlaylistClient.createPlaylist", () => {
  it("posts the requested metadata and returns the new playlist ID", async () => {
    const { calls, fetchImpl } = respond({ status: "STATUS_SUCCEEDED", playlistId: "PLnew" });

    const playlistId = await client(fetchImpl).createPlaylist({
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
    expect(jsonBody(call)).toMatchObject({
      title: "Playlist Battle — Ação & Música 🎵",
      description: "Round winners",
      privacyStatus: "UNLISTED",
    });
  });

  it("identifies itself as the YT Music web client with today's client version", async () => {
    const { calls, fetchImpl } = respond({ status: "STATUS_SUCCEEDED", playlistId: "PLnew" });

    await client(fetchImpl).createPlaylist({ title: "t", description: "d", privacy: "PUBLIC" });

    const context = jsonBody(calls[0]!)["context"] as {
      client: { clientName: string; clientVersion: string };
    };
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const today = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
    expect(context.client.clientName).toBe("WEB_REMIX");
    expect(context.client.clientVersion).toBe(`1.${today}.01.00`);
  });

  it("signs the request with a SAPISIDHASH over the cookie's own SAPISID value", async () => {
    const { calls, fetchImpl } = respond({ status: "STATUS_SUCCEEDED", playlistId: "PLnew" });

    await client(fetchImpl).createPlaylist({ title: "t", description: "d", privacy: "PUBLIC" });

    const headers = calls[0]!.init.headers as Record<string, string>;
    const match = /^SAPISIDHASH (\d+)_([0-9a-f]{40})$/.exec(headers["authorization"]!);
    expect(match).not.toBeNull();
    const [, timestamp, digest] = match!;
    const expected = createHash("sha1")
      .update(`${timestamp} ${SAPISID} https://music.youtube.com`)
      .digest("hex");
    expect(digest).toBe(expected);
  });

  it("forwards the cookie verbatim, keeping '=' inside cookie values", async () => {
    const { calls, fetchImpl } = respond({ status: "STATUS_SUCCEEDED", playlistId: "PLnew" });

    await client(fetchImpl, 2).createPlaylist({ title: "t", description: "d", privacy: "PUBLIC" });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["cookie"]).toContain(`__Secure-3PAPISID=${SAPISID}`);
    expect(headers["x-goog-authuser"]).toBe("2");
    expect(headers["x-origin"]).toBe("https://music.youtube.com");
  });

  it("rejects a cookie without __Secure-3PAPISID instead of sending a broken hash", () => {
    expect(() => new YtMusicPlaylistClient({ auth: { cookie: "SID=abc" } })).toThrowError(
      expect.objectContaining({ name: "YtMusicError", kind: "auth" }),
    );
  });

  it("classifies an expired session as an auth error", async () => {
    const { fetchImpl } = respond({ error: { code: 401 } }, 401);

    await expect(
      client(fetchImpl).createPlaylist({ title: "t", description: "d", privacy: "PUBLIC" }),
    ).rejects.toMatchObject({ name: "YtMusicError", kind: "auth" });
  });

  it("classifies a dialog response as gated, not as success", async () => {
    const { fetchImpl } = respond({
      actions: [{ showEngagementPanelEndpoint: { identifier: { tag: "captcha" } } }],
    });

    await expect(
      client(fetchImpl).createPlaylist({ title: "t", description: "d", privacy: "PUBLIC" }),
    ).rejects.toMatchObject({ kind: "gated", message: expect.stringContaining("captcha") });
  });

  it("rejects a write YouTube answered with a failure status", async () => {
    const { fetchImpl } = respond({
      status: "STATUS_FAILED",
      error: { code: 400, message: "Invalid title" },
    });

    const err = await client(fetchImpl)
      .createPlaylist({ title: "t", description: "d", privacy: "PUBLIC" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(YtMusicError);
    expect(err).toMatchObject({ kind: "rejected", message: expect.stringContaining("Invalid title") });
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
