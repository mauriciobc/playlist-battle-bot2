import { describe, expect, it, vi } from "vitest";
import {
  createBattlePlaylistPublisher,
  sanitizePlaylistText,
  YT_MUSIC_PLAYLIST_URL,
} from "../src/youtube/playlist.js";

const AUTH = { cookie: "SID=abc; __Secure-3PAPISID=AbC123" };
const QUEUE_URL = "https://www.youtube.com/watch?v=vidA&list=TLGGabc123";
const TUNES = [
  { round: 1, videoId: "vidA" },
  { round: 2, videoId: "vidB" },
];

type Captured = { url: string; init: RequestInit };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function upstream(overrides: { create?: Response; queue?: Response } = {}) {
  const calls: Captured[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, init: init ?? {} });
    if (target.includes("playlist/create")) {
      return overrides.create ?? json({ status: "STATUS_SUCCEEDED", playlistId: "PLacct" });
    }
    if (target.includes("browse/edit_playlist")) return json({ status: "STATUS_SUCCEEDED" });
    if (target.includes("watch_videos")) {
      return overrides.queue ?? new Response(null, { status: 303, headers: { location: QUEUE_URL } });
    }
    throw new Error(`unexpected request to ${target}`);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function publish(
  opts: { auth?: typeof AUTH; fetchImpl: typeof fetch; log?: (message: string, detail?: unknown) => void },
  input: { theme?: string; tunes?: typeof TUNES; existingPlaylistId?: string | null } = {},
) {
  return createBattlePlaylistPublisher(opts)({
    theme: "Road Trip",
    rounds: 8,
    tunes: TUNES,
    existingPlaylistId: null,
    ...input,
  });
}

const bodyOf = (call: Captured) => JSON.parse(String(call.init.body)) as Record<string, unknown>;
const addedIds = (call: Captured) =>
  (bodyOf(call).actions as { addedVideoId: string }[]).map((a) => a.addedVideoId);

describe("createBattlePlaylistPublisher with an account", () => {
  it("creates the playlist, fills it in round order and returns its URL", async () => {
    const { calls, fetchImpl } = upstream();

    const link = await publish({ auth: AUTH, fetchImpl });

    expect(link).toEqual({ url: `${YT_MUSIC_PLAYLIST_URL}PLacct`, playlistId: "PLacct" });
    const [create, add] = calls;
    expect(bodyOf(create!).title).toContain("Road Trip");
    expect(bodyOf(create!).privacyStatus).toBe("PUBLIC");
    expect(addedIds(add!)).toEqual(["vidA", "vidB"]);
  });

  it("adds a video won in two rounds only once (YouTube rejects duplicate batches)", async () => {
    const { calls, fetchImpl } = upstream();

    await publish({ auth: AUTH, fetchImpl }, { tunes: [...TUNES, { round: 3, videoId: "vidA" }] });

    expect(addedIds(calls.find((c) => c.url.includes("browse/edit_playlist"))!)).toEqual(["vidA", "vidB"]);
  });

  it("reuses the playlist recorded by an earlier attempt without touching YouTube", async () => {
    const { calls, fetchImpl } = upstream();

    const link = await publish({ auth: AUTH, fetchImpl }, { existingPlaylistId: "PLresumed" });

    expect(link).toEqual({ url: `${YT_MUSIC_PLAYLIST_URL}PLresumed`, playlistId: "PLresumed" });
    expect(calls).toHaveLength(0);
  });

  it("strips markup characters YouTube rejects from the playlist metadata", async () => {
    const { calls, fetchImpl } = upstream();

    await publish({ auth: AUTH, fetchImpl }, { theme: 'A <b>"bold"</b> theme' });

    const body = bodyOf(calls[0]!);
    expect(body.title).not.toMatch(/[<>]/);
    expect(body.description).not.toMatch(/[<>]/);
  });

  it("falls back to an anonymous queue link when the account write is refused", async () => {
    const log = vi.fn();
    const { fetchImpl } = upstream({ create: json({ error: { code: 401 } }, 401) });

    const link = await publish({ auth: AUTH, fetchImpl, log });

    expect(link).toEqual({ url: QUEUE_URL, playlistId: null });
    expect(log).toHaveBeenCalledWith(expect.any(String), "auth");
  });
});

describe("createBattlePlaylistPublisher without an account", () => {
  it("returns the anonymous queue link", async () => {
    const { calls, fetchImpl } = upstream();

    await expect(publish({ fetchImpl })).resolves.toEqual({ url: QUEUE_URL, playlistId: null });
    expect(calls.map((c) => c.url)).toEqual(["https://www.youtube.com/watch_videos?video_ids=vidA,vidB"]);
  });

  it("publishes nothing when YouTube hands back no queue", async () => {
    const { fetchImpl } = upstream({ queue: json({}, 200) });

    await expect(publish({ fetchImpl })).resolves.toBeNull();
  });

  it("publishes nothing for a battle with a single round winner", async () => {
    const { calls, fetchImpl } = upstream();

    await expect(publish({ fetchImpl }, { tunes: [{ round: 1, videoId: "vidA" }] })).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("sanitizePlaylistText", () => {
  it("drops markup characters, collapses whitespace and clamps length", () => {
    expect(sanitizePlaylistText("  a <b>  c\nd  ", 100)).toBe("a b c d");
    expect(sanitizePlaylistText("x".repeat(30), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
