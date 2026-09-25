import { describe, expect, it, vi } from "vitest";
import { resolveQueueUrl } from "../src/youtube/queue.js";

const IDS = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"];
const QUEUE_URL = `https://www.youtube.com/watch?v=${IDS[0]}&list=TLGGabc123`;

function redirect(location: string | null, status = 303): Response {
  return new Response(null, { status, headers: location ? { location } : {} });
}

describe("resolveQueueUrl", () => {
  it("resolves the playlist redirect into a shareable queue URL", async () => {
    const fetchImpl = vi.fn(async () => redirect(QUEUE_URL));

    await expect(
      resolveQueueUrl(IDS, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBe(QUEUE_URL);

    // A followed redirect would return the final page instead of the URL.
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://www.youtube.com/watch_videos?video_ids=aaaaaaaaaaa,bbbbbbbbbbb,ccccccccccc",
      expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }),
    );
  });

  it.each<[string, () => Promise<Response>]>([
    ["YouTube answers without a playlist redirect", async () => redirect(null, 200)],
    ["the redirect leaves youtube.com", async () => redirect("https://consent.youtube.com/m?continue=x")],
    [
      "the request fails",
      async () => {
        throw new Error("network down");
      },
    ],
  ])("returns null when %s", async (_case, fetchImpl) => {
    await expect(resolveQueueUrl(IDS, { fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toBeNull();
  });
});
