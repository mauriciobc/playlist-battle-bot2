import { describe, expect, it, vi } from "vitest";
import {
  createBattlePlaylistPublisher,
  sanitizePlaylistText,
  YT_MUSIC_PLAYLIST_URL,
} from "../src/youtube/playlist.js";

const COOKIE = "SID=abc; __Secure-3PAPISID=AbC123";
const QUEUE_URL = "https://www.youtube.com/watch?v=vidA&list=TLGGabc123";
const AUTH = { cookie: COOKIE };

type Captured = { url: string; init: RequestInit };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function upstream(overrides: { create?: Response; edit?: Response; queue?: Response } = {}) {
  const calls: Captured[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, init: init ?? {} });
    if (target.includes("playlist/create")) {
      return overrides.create ?? json({ status: "STATUS_SUCCEEDED", playlistId: "PLacct" });
    }
    if (target.includes("browse/edit_playlist")) {
      return overrides.edit ?? json({ status: "STATUS_SUCCEEDED" });
    }
    if (target.includes("watch_videos")) {
      return overrides.queue ?? new Response(null, { status: 303, headers: { location: QUEUE_URL } });
    }
    throw new Error(`unexpected request to ${target}`);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function actionsOf(call: Captured): { action: string; addedVideoId: string }[] {
  return (JSON.parse(String(call.init.body)) as { actions: { action: string; addedVideoId: string }[] })
    .actions;
}

const TUNES = [
  { round: 1, videoId: "vidA" },
  { round: 2, videoId: "vidB" },
];

describe("createBattlePlaylistPublisher with an account", () => {
  it("creates the playlist, fills it in round order and returns its URL", async () => {
    const { calls, fetchImpl } = upstream();

    const link = await createBattlePlaylistPublisher({ auth: AUTH, fetchImpl })({
      theme: "Road Trip",
      rounds: 8,
      tunes: TUNES,
      existingPlaylistId: null,
    });

    expect(link).toEqual({ url: `${YT_MUSIC_PLAYLIST_URL}PLacct`, playlistId: "PLacct" });
    const [create, add] = calls;
    const createBody = JSON.parse(String(create!.init.body)) as Record<string, unknown>;
    expect(createBody["title"]).toContain("Road Trip");
    expect(createBody["privacyStatus"]).toBe("PUBLIC");
    expect(actionsOf(add!).map((a) => a.addedVideoId)).toEqual(["vidA", "vidB"]);
  });

  it("adds a video won in two rounds only once (YouTube rejects duplicate batches)", async () => {
    const { calls, fetchImpl } = upstream();

    await createBattlePlaylistPublisher({ auth: AUTH, fetchImpl })({
      theme: "Road Trip",
      rounds: 8,
      tunes: [...TUNES, { round: 3, videoId: "vidA" }],
      existingPlaylistId: null,
    });

    const add = calls.find((c) => c.url.includes("browse/edit_playlist"))!;
    expect(actionsOf(add).map((a) => a.addedVideoId)).toEqual(["vidA", "vidB"]);
  });

  it("reuses the playlist recorded by an earlier attempt without touching YouTube", async () => {
    const { calls, fetchImpl } = upstream();

    const link = await createBattlePlaylistPublisher({ auth: AUTH, fetchImpl })({
      theme: "Road Trip",
      rounds: 8,
      tunes: TUNES,
      existingPlaylistId: "PLresumed",
    });

    expect(link).toEqual({ url: `${YT_MUSIC_PLAYLIST_URL}PLresumed`, playlistId: "PLresumed" });
    expect(calls).toHaveLength(0);
  });

  it("strips markup characters YouTube rejects from the playlist metadata", async () => {
    const { calls, fetchImpl } = upstream();

    await createBattlePlaylistPublisher({ auth: AUTH, fetchImpl })({
      theme: 'A <b>"bold"</b> theme',
      rounds: 8,
      tunes: TUNES,
      existingPlaylistId: null,
    });

    const body = JSON.parse(String(calls[0]!.init.body)) as { title: string; description: string };
    expect(body.title).not.toMatch(/[<>]/);
    expect(body.description).not.toMatch(/[<>]/);
  });

  it("falls back to an anonymous queue link when the account write is refused", async () => {
    const log = vi.fn();
    const { fetchImpl } = upstream({ create: json({ error: { code: 401 } }, 401) });

    const link = await createBattlePlaylistPublisher({ auth: AUTH, fetchImpl, log })({
      theme: "Road Trip",
      rounds: 8,
      tunes: TUNES,
      existingPlaylistId: null,
    });

    expect(link).toEqual({ url: QUEUE_URL, playlistId: null });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("finale playlist"), "auth");
  });
});

describe("createBattlePlaylistPublisher without an account", () => {
  it("returns the anonymous queue link", async () => {
    const { calls, fetchImpl } = upstream();

    const link = await createBattlePlaylistPublisher({ fetchImpl })({
      theme: "Road Trip",
      rounds: 8,
      tunes: TUNES,
      existingPlaylistId: null,
    });

    expect(link).toEqual({ url: QUEUE_URL, playlistId: null });
    expect(calls.map((c) => c.url)).toEqual([
      "https://www.youtube.com/watch_videos?video_ids=vidA,vidB",
    ]);
  });

  it("publishes nothing when YouTube hands back no queue", async () => {
    const { fetchImpl } = upstream({ queue: json({}, 200) });

    const link = await createBattlePlaylistPublisher({ fetchImpl })({
      theme: "Road Trip",
      rounds: 8,
      tunes: TUNES,
      existingPlaylistId: null,
    });

    expect(link).toBeNull();
  });

  it("publishes nothing for a battle with a single round winner", async () => {
    const { calls, fetchImpl } = upstream();

    const link = await createBattlePlaylistPublisher({ fetchImpl })({
      theme: "Road Trip",
      rounds: 8,
      tunes: [{ round: 1, videoId: "vidA" }],
      existingPlaylistId: null,
    });

    expect(link).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("sanitizePlaylistText", () => {
  it("drops markup characters, collapses whitespace and clamps length", () => {
    expect(sanitizePlaylistText("  a <b>  c\nd  ", 100)).toBe("a b c d");
    expect(sanitizePlaylistText("x".repeat(30), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
