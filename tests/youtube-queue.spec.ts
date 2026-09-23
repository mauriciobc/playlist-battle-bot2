import { describe, expect, it, vi } from "vitest";
import { MIN_QUEUE_TUNES, resolveQueueUrl, watchVideosUrl } from "../src/youtube/queue.js";

const IDS = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"];
const QUEUE_URL = `https://www.youtube.com/watch?v=${IDS[0]}&list=TLGGabc123`;

function redirect(location: string | null, status = 303): Response {
  return new Response(null, { status, headers: location ? { location } : {} });
}

describe("watchVideosUrl", () => {
  it("lists the video IDs in play order on the anonymous queue endpoint", () => {
    expect(watchVideosUrl(IDS)).toBe(
      "https://www.youtube.com/watch_videos?video_ids=aaaaaaaaaaa,bbbbbbbbbbb,ccccccccccc",
    );
  });
});

describe("resolveQueueUrl", () => {
  it("resolves the playlist redirect into a shareable queue URL", async () => {
    const fetchImpl = vi.fn(async () => redirect(QUEUE_URL));

    await expect(
      resolveQueueUrl(IDS, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBe(QUEUE_URL);

    // A followed redirect would return the final page instead of the URL.
    expect(fetchImpl).toHaveBeenCalledWith(
      watchVideosUrl(IDS),
      expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }),
    );
  });

  it("publishes nothing for a single tune, without asking YouTube", async () => {
    const fetchImpl = vi.fn(async () => redirect(QUEUE_URL));

    expect(MIN_QUEUE_TUNES).toBe(2);
    await expect(
      resolveQueueUrl([IDS[0]!], { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when YouTube answers without a playlist redirect", async () => {
    const fetchImpl = vi.fn(async () => redirect(null, 200));

    await expect(
      resolveQueueUrl(IDS, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeNull();
  });

  it("returns null when the redirect leaves youtube.com", async () => {
    const fetchImpl = vi.fn(async () => redirect("https://consent.youtube.com/m?continue=x"));

    await expect(
      resolveQueueUrl(IDS, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeNull();
  });

  it("returns null when the request fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });

    await expect(
      resolveQueueUrl(IDS, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeNull();
  });
});
