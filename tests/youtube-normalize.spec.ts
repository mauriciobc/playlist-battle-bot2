import { describe, expect, it } from "vitest";
import { normalizeYouTubeUrl, extractVideoId } from "../src/youtube/normalize.js";

describe("extractVideoId / normalizeYouTubeUrl", () => {
  it("parses standard watch?v= URLs", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("http://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("parses youtu.be short links", () => {
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ?t=10")).toBe("dQw4w9WgXcQ");
  });

  it("parses /shorts/ URLs", () => {
    expect(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ?si=abc")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("parses /embed/ URLs", () => {
    expect(extractVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("parses music.youtube.com watch URLs", () => {
    expect(extractVideoId("https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=xyz")).toBe(
      "dQw4w9WgXcQ",
    );
    expect(extractVideoId("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVM")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("parses /live/ URLs", () => {
    expect(extractVideoId("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("returns canonical https://www.youtube.com/watch?v=ID for normalize", () => {
    expect(normalizeYouTubeUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
    expect(normalizeYouTubeUrl("https://music.youtube.com/watch?v=dQw4w9WgXcQ&si=x")).toBe(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    );
  });

  it("rejects non-YouTube hosts", () => {
    expect(extractVideoId("https://vimeo.com/12345")).toBeNull();
    expect(extractVideoId("https://evil.com/youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(extractVideoId("https://notyoutube.example/watch?v=dQw4w9WgXcQ")).toBeNull();
  });

  it("rejects YouTube URLs without a video id", () => {
    expect(extractVideoId("https://www.youtube.com/")).toBeNull();
    expect(extractVideoId("https://www.youtube.com/results?search_query=cats")).toBeNull();
    expect(extractVideoId("https://www.youtube.com/watch?v=")).toBeNull();
    expect(extractVideoId("https://youtu.be/")).toBeNull();
    expect(extractVideoId("https://www.youtube.com/playlist?list=PL123")).toBeNull();
  });

  it("rejects malformed ids (wrong length / charset)", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=short")).toBeNull();
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQextraLongId")).toBeNull();
    expect(extractVideoId("https://www.youtube.com/watch?v=bad!chars@@")).toBeNull();
  });

  it("rejects non-http(s) schemes", () => {
    expect(extractVideoId("javascript:alert(1)")).toBeNull();
    expect(extractVideoId("ftp://youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(extractVideoId("not a url")).toBeNull();
  });

  it("handles bare video IDs defensively (accepted as 11-char ID)", () => {
    expect(extractVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
});
