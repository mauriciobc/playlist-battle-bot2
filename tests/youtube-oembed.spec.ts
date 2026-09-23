import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, migrate, type Db } from "../src/db/index.js";
import { resolveTitle, type ResolvedTune } from "../src/youtube/oembed.js";

const TITLE = "Rick Astley - Never Gonna Give You Up (Official Video)";

function oembedBody(title = TITLE) {
  return {
    title,
    author_name: "Rick Astley",
    author_url: "https://www.youtube.com/@RickAstleyYT",
    type: "video",
    provider_name: "YouTube",
  };
}

describe("resolveTitle", () => {
  let dir: string;
  let db: Db;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pb-oembed-"));
    db = openDatabase(join(dir, "test.db"));
    migrate(db);
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(oembedBody()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("resolves a title via YouTube oEmbed and caches by video ID", async () => {
    const resolved = await resolveTitle("dQw4w9WgXcQ", { db, fetchImpl: fetchMock as unknown as typeof fetch });
    expect(resolved.title).toBe(TITLE);
    expect(resolved.author).toBe("Rick Astley");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const cached = db.prepare("SELECT title FROM video_cache WHERE video_id = ?").get("dQw4w9WgXcQ") as
      | { title: string }
      | undefined;
    expect(cached?.title).toBe(TITLE);
  });

  it("serves subsequent resolves from cache without network", async () => {
    await resolveTitle("dQw4w9WgXcQ", { db, fetchImpl: fetchMock as unknown as typeof fetch });
    const second = await resolveTitle("dQw4w9WgXcQ", { db, fetchImpl: fetchMock as unknown as typeof fetch });
    expect(second.title).toBe(TITLE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws UnresolvableVideoError when oEmbed 404s (deleted/private)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Not found" }), { status: 404 }),
    );
    await expect(
      resolveTitle("aaaaaaaaaaa", { db, fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toMatchObject({ name: "UnresolvableVideoError" });
    // negative result is not cached — may become available later
    expect(db.prepare("SELECT 1 FROM video_cache WHERE video_id = ?").get("aaaaaaaaaaa")).toBeUndefined();
  });

  it("throws UnresolvableVideoError when oEmbed returns no title", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ provider_name: "YouTube" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      resolveTitle("bbbbbbbbbbb", { db, fetchImpl: fetchMock as unknown as typeof fetch }),
    ).rejects.toMatchObject({ name: "UnresolvableVideoError" });
  });

  it("passes canonical watch URL to oEmbed endpoint", async () => {
    await resolveTitle("dQw4w9WgXcQ", { db, fetchImpl: fetchMock as unknown as typeof fetch });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("https://www.youtube.com/oembed");
    expect(url).toContain(encodeURIComponent("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
    expect(url).toContain("format=json");
  });

  it("returns ResolvedTune shape with videoId + canonicalUrl", async () => {
    const resolved: ResolvedTune = await resolveTitle("dQw4w9WgXcQ", {
      db,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(resolved).toMatchObject({
      videoId: "dQw4w9WgXcQ",
      title: TITLE,
      canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
  });
});
