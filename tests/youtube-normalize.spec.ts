import { describe, expect, it } from "vitest";
import { normalizeYouTubeUrl, extractVideoId } from "../src/youtube/normalize.js";

describe("extractVideoId / normalizeYouTubeUrl", () => {
  it.each([
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
    "https://youtu.be/dQw4w9WgXcQ?t=10",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ?si=abc",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVM",
    "https://www.youtube.com/live/dQw4w9WgXcQ",
    // bare video IDs are accepted defensively
    "dQw4w9WgXcQ",
  ])("extracts the id from %s", (url) => {
    expect(extractVideoId(url)).toBe("dQw4w9WgXcQ");
  });

  it.each([
    // non-YouTube hosts
    "https://vimeo.com/12345",
    "https://evil.com/youtube.com/watch?v=dQw4w9WgXcQ",
    "https://notyoutube.example/watch?v=dQw4w9WgXcQ",
    // YouTube URLs without a video id
    "https://www.youtube.com/",
    "https://www.youtube.com/results?search_query=cats",
    "https://www.youtube.com/watch?v=",
    "https://youtu.be/",
    "https://www.youtube.com/playlist?list=PL123",
    // malformed ids (wrong length / charset)
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQextraLongId",
    "https://www.youtube.com/watch?v=bad!chars@@",
    // non-http(s) schemes
    "javascript:alert(1)",
    "ftp://youtube.com/watch?v=dQw4w9WgXcQ",
    "not a url",
  ])("rejects %s", (url) => {
    expect(extractVideoId(url)).toBeNull();
  });

  it("normalizes to canonical https://www.youtube.com/watch?v=ID", () => {
    expect(normalizeYouTubeUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=x")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(normalizeYouTubeUrl("https://vimeo.com/12345")).toBeNull();
  });
});
