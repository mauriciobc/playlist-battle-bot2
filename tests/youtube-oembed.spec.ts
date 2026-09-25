import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { openDatabase, migrate, type Db } from "../src/db/index.js";
import { resolveTitle } from "../src/youtube/oembed.js";

const TITLE = "Rick Astley - Never Gonna Give You Up (Official Video)";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("resolveTitle", () => {
  let db: Db;
  let fetchMock: Mock;
  let opts: { db: Db; fetchImpl: typeof fetch };

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db);
    fetchMock = vi.fn(async () => jsonResponse({ title: TITLE, author_name: "Rick Astley", type: "video" }));
    opts = { db, fetchImpl: fetchMock as unknown as typeof fetch };
  });

  afterEach(() => db.close());

  it("resolves a title via YouTube oEmbed for the canonical watch URL, then serves it from cache", async () => {
    const resolved = await resolveTitle("dQw4w9WgXcQ", opts);
    expect(resolved).toEqual({
      videoId: "dQw4w9WgXcQ",
      title: TITLE,
      author: "Rick Astley",
      canonicalUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("https://www.youtube.com/oembed");
    expect(url).toContain(encodeURIComponent("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
    expect(url).toContain("format=json");

    await expect(resolveTitle("dQw4w9WgXcQ", opts)).resolves.toEqual(resolved);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["404s (deleted/private)", jsonResponse({ error: "Not found" }, 404)],
    ["returns no title", jsonResponse({ provider_name: "YouTube" })],
  ])("throws UnresolvableVideoError, caching nothing, when oEmbed %s", async (_case, response) => {
    fetchMock.mockResolvedValueOnce(response);
    await expect(resolveTitle("aaaaaaaaaaa", opts)).rejects.toMatchObject({ name: "UnresolvableVideoError" });
    // negative result is not cached — may become available later
    expect(db.prepare("SELECT 1 FROM video_cache WHERE video_id = ?").get("aaaaaaaaaaa")).toBeUndefined();
  });
});
