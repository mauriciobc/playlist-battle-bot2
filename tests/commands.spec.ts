import { describe, expect, it } from "vitest";
import { parseCreateCommand, parseStatusCommand, parseDmReply, htmlToText } from "../src/handlers/commands.js";

/** Strip HTML that Mastodon wraps status content in, for command parsing. */
function html(s: string): string {
  return s;
}

describe("htmlToText entity decoding", () => {
  it("decodes standard entities", () => {
    expect(htmlToText("<p>&lt;b&gt; &amp; bold &quot;quoted&quot;&#39;</p>")).toBe("<b> & bold \"quoted\"'");
  });

  it("preserves Mastodon mention @ prefixes (same instance)", () => {
    const html = '<p><span class="h-card" translate="no"><a href="https://mastodon.social/@alice" class="u-url mention">@<span>alice</span></a></span> hello</p>';
    expect(htmlToText(html)).toBe("@alice hello");
  });

  it("preserves Mastodon mention @ prefixes (cross-instance)", () => {
    const html = '<p><span class="h-card" translate="no"><a href="https://ursal.zone/@alice" class="u-url mention">@<span>alice@ursal.zone</span></a></span> hello</p>';
    expect(htmlToText(html)).toBe("@alice@ursal.zone hello");
  });

  it("handles Mastodon mention HTML with invisible prefix spans", () => {
    const html = '<p><a href="https://ursal.zone/@alice" class="u-url mention"><span class="invisible">https://ursal.zone/</span><span>@alice@ursal.zone</span></a> hello</p>';
    const result = htmlToText(html);
    expect(result).toContain("@alice@ursal.zone");
  });

  it("preserves multiple mentions (same + cross-instance) in one status", () => {
    const html = '<p><a href="https://mastodon.social/@bot" class="u-url mention">@<span>bot</span></a> newgame "X" 8 <a href="https://ursal.zone/@alice" class="u-url mention">@<span>alice@ursal.zone</span></a></p>';
    const result = htmlToText(html);
    expect(result).toBe('@bot newgame "X" 8 @alice@ursal.zone');
  });

  it("preserves @ in mention even when preceded by other text", () => {
    const html = '<p>hey <a href="https://ursal.zone/@bob" class="u-url mention">@<span>bob@ursal.zone</span></a> check this out</p>';
    const result = htmlToText(html);
    expect(result).toBe("hey @bob@ursal.zone check this out");
  });

  it("does not double-decode (htmlToText('&amp;lt;') is the literal '&lt;')", () => {
    expect(htmlToText("&amp;lt;")).toBe("&lt;");
    expect(htmlToText("a &amp;amp; b")).toBe("a &amp; b");
  });
});


describe("parseCreateCommand", () => {
  const BOT = "playlistbattle";

  it("parses newgame with quoted theme, length, and challengers", () => {
    const r = parseCreateCommand(
      html(`@${BOT} newgame "80s Synth Wave" 8 @alice @bob`),
      BOT,
    );
    expect(r).toMatchObject({
      theme: "80s Synth Wave",
      playlistLength: 8,
      challengers: ["alice", "bob"],
    });
  });

  it("parses single-quoted theme", () => {
    const r = parseCreateCommand(`@${BOT} newgame 'Road Trip' 12 @carol`, BOT);
    expect(r).toMatchObject({ theme: "Road Trip", playlistLength: 12, challengers: ["carol"] });
  });

  it("parses unquoted multi-word theme (greedy until length)", () => {
    const r = parseCreateCommand(`@${BOT} newgame best of 90s alternative 10 @dave`, BOT);
    expect(r).toMatchObject({ theme: "best of 90s alternative", playlistLength: 10 });
    expect(r && "challengers" in r ? r.challengers : null).toEqual(["dave"]);
  });

  it("accepts three challengers", () => {
    const r = parseCreateCommand(`@${BOT} newgame "X" 8 @a @b @c`, BOT);
    expect(r && "challengers" in r ? r.challengers : null).toEqual(["a", "b", "c"]);
  });

  it("returns null when not mentioning the bot", () => {
    expect(parseCreateCommand(`@someoneElse newgame "X" 8 @a`, BOT)).toBeNull();
  });

  it("returns null when command keyword missing", () => {
    expect(parseCreateCommand(`@${BOT} hello`, BOT)).toBeNull();
    expect(parseCreateCommand(`@${BOT} status`, BOT)).toBeNull();
  });

  it("returns error result for bad length", () => {
    const r = parseCreateCommand(`@${BOT} newgame "X" 5 @a`, BOT);
    expect(r).toMatchObject({ error: expect.stringContaining("8") });
  });


  it("allows cross-instance same-handle as challenger (different person)", () => {
    const r = parseCreateCommand(
      `@${BOT} newgame "X" 8 @${BOT}@other.instance`,
      BOT,
    );
    expect(r).toMatchObject({ theme: "X", challengers: [`${BOT}@other.instance`] });
  });

  it("allows cross-instance same-handle with instanceDomain param", () => {
    const r = parseCreateCommand(
      `@${BOT} newgame "X" 8 @${BOT}@other.instance`,
      BOT,
      "mastodon.social",
    );
    expect(r).toMatchObject({ theme: "X", challengers: [`${BOT}@other.instance`] });
  });

  it("still filters bot's own bare mention as challenger", () => {
    const r = parseCreateCommand(`@${BOT} newgame "X" 8 @${BOT}`, BOT);
    expect(r).toMatchObject({ error: expect.stringMatching(/challenger/i) });
  });

  it("still filters bot's fully-qualified same-instance mention", () => {
    const r = parseCreateCommand(
      `@${BOT} newgame "X" 8 @${BOT}@mastodon.social`,
      BOT,
      "mastodon.social",
    );
    expect(r).toMatchObject({ error: expect.stringMatching(/challenger/i) });
  });

  it("allows cross-instance different-handle as challenger", () => {
    const r = parseCreateCommand(
      `@${BOT} newgame "X" 8 @alice@other.social`,
      BOT,
    );
    expect(r).toMatchObject({ theme: "X", challengers: ["alice@other.social"] });
  });

  it("allows mixed same-instance and cross-instance challengers", () => {
    const r = parseCreateCommand(
      `@${BOT} newgame "X" 8 @alice @bob@other.social`,
      BOT,
    );
    expect(r).toMatchObject({ theme: "X", challengers: ["alice", "bob@other.social"] });
  });

  it("allows multiple cross-instance challengers", () => {
    const r = parseCreateCommand(
      `@${BOT} newgame "X" 8 @alice@instance1.social @bob@instance2.social`,
      BOT,
    );
    expect(r).toMatchObject({
      theme: "X",
      challengers: ["alice@instance1.social", "bob@instance2.social"],
    });
  });

  it("detects bot via @bot@domain mention (remote instance)", () => {
    const r = parseCreateCommand(
      `@${BOT}@remote.social newgame "X" 8 @alice`,
      BOT,
    );
    expect(r).toMatchObject({ theme: "X", challengers: ["alice"] });
  });

  it("filters bot's cross-instance mention when it matches bot's full handle", () => {
    const r = parseCreateCommand(
      `@${BOT} newgame "X" 8 @${BOT}@other.social`,
      BOT,
      "other.social",
    );
    expect(r).toMatchObject({ error: expect.stringMatching(/challenger/i) });
  });

  it("handles three cross-instance challengers", () => {
    const r = parseCreateCommand(
      `@${BOT} newgame "X" 8 @a@mastodon.social @b@bsky.social @c@ursal.zone`,
      BOT,
    );
    expect(r).toMatchObject({
      theme: "X",
      challengers: ["a@mastodon.social", "b@bsky.social", "c@ursal.zone"],
    });
  });

  it("returns error result when no challengers", () => {
    const r = parseCreateCommand(`@${BOT} newgame "X" 8`, BOT);
    expect(r).toMatchObject({ error: expect.stringMatching(/challenger/i) });
  });

  it("returns error result for too many challengers", () => {
    const r = parseCreateCommand(`@${BOT} newgame "X" 8 @a @b @c @d`, BOT);
    expect(r).toMatchObject({ error: expect.stringMatching(/4 players|challenger/i) });
  });

  it("handles mention variants (@bot@domain)", () => {
    const r = parseCreateCommand(`@${BOT}@mastodon.example newgame "X" 8 @a`, BOT);
    expect(r).toMatchObject({ theme: "X", challengers: ["a"] });
  });

  it("is a discriminated result: ok vs error", () => {
    const ok = parseCreateCommand(`@${BOT} newgame "T" 9 @x`, BOT);
    expect(ok).not.toHaveProperty("error");
    const bad = parseCreateCommand(`@${BOT} newgame "T" 3 @x`, BOT);
    expect(bad).toHaveProperty("error");
  });
});

describe("parseStatusCommand", () => {
  const BOT = "playlistbattle";

  it("recognizes status command", () => {
    expect(parseStatusCommand("@playlistbattle status", BOT)).toBe(true);
    expect(parseStatusCommand("@playlistbattle@x.social status", BOT)).toBe(true);
    expect(parseStatusCommand("@playlistbattle help", BOT)).toBe(true);
  });

  it("rejects other text", () => {
    expect(parseStatusCommand("@playlistbattle newgame", BOT)).toBe(false);
    expect(parseStatusCommand("just chatting", BOT)).toBe(false);
    expect(parseStatusCommand("@other status", BOT)).toBe(false);
  });
});

describe("parseDmReply (accept/decline/cancel/links)", () => {
  it("parses accept", () => {
    expect(parseDmReply("accept")).toEqual({ kind: "accept" });
    expect(parseDmReply("  ACCEPT ")).toEqual({ kind: "accept" });
    expect(parseDmReply("Accept!")).toEqual({ kind: "accept" });
  });

  it("strips leading @bot mention (Mastodon reply/compose prefix)", () => {
    expect(parseDmReply("@playlistbattle accept")).toEqual({ kind: "accept" });
    expect(parseDmReply("@playlistbattle@mastodon.example accept")).toEqual({ kind: "accept" });
    expect(parseDmReply("@playlistbattle\naccept")).toEqual({ kind: "accept" });
    expect(parseDmReply("<p>@playlistbattle accept</p>".replace(/<[^>]+>/g, ""))).toEqual({
      kind: "accept",
    });
    expect(parseDmReply("@playlistbattle decline")).toEqual({ kind: "decline" });
    expect(parseDmReply("@playlistbattle cancel")).toEqual({ kind: "cancel" });
  });

  it("strips leading mention before links and replace", () => {
    expect(parseDmReply("@playlistbattle https://youtu.be/dQw4w9WgXcQ")).toEqual({
      kind: "links",
      urls: ["https://youtu.be/dQw4w9WgXcQ"],
    });
    expect(
      parseDmReply("@playlistbattle replace 3 https://youtu.be/dQw4w9WgXcQ"),
    ).toMatchObject({ kind: "replace", position: 3 });
  });

  it("parses decline", () => {
    expect(parseDmReply("decline")).toEqual({ kind: "decline" });
    expect(parseDmReply("Decline")).toEqual({ kind: "decline" });
  });

  it("parses cancel (host voids an open game)", () => {
    expect(parseDmReply("cancel")).toEqual({ kind: "cancel" });
    expect(parseDmReply("  CANCEL ")).toEqual({ kind: "cancel" });
    // a word merely starting with "cancel" is not the command
    expect(parseDmReply("cancellation")).toEqual({ kind: "unknown" });
  });

  it("parses a single YouTube link", () => {
    const r = parseDmReply("https://youtu.be/dQw4w9WgXcQ");
    expect(r).toEqual({ kind: "links", urls: ["https://youtu.be/dQw4w9WgXcQ"] });
  });

  it("parses one-per-line fast path (PRD §5.3)", () => {
    const msg = ["https://youtu.be/aaaaaaaaaaa", "https://www.youtube.com/watch?v=bbbbbbbbbbb", "https://music.youtube.com/watch?v=ccccccccccc"].join("\n");
    const r = parseDmReply(msg);
    expect(r).toEqual({
      kind: "links",
      urls: [
        "https://youtu.be/aaaaaaaaaaa",
        "https://www.youtube.com/watch?v=bbbbbbbbbbb",
        "https://music.youtube.com/watch?v=ccccccccccc",
      ],
    });
  });

  it("mixed lines: links extracted, non-link lines ignored", () => {
    const msg = "here you go:\nhttps://youtu.be/aaaaaaaaaaa\nthanks!";
    const r = parseDmReply(msg);
    expect(r).toEqual({ kind: "links", urls: ["https://youtu.be/aaaaaaaaaaa"] });
  });

  it("plain text that is not accept/decline/link → unknown", () => {
    expect(parseDmReply("what do I do?")).toEqual({ kind: "unknown" });
    expect(parseDmReply("")).toEqual({ kind: "unknown" });
  });

  it("accept keyword wins over embedded link", () => {
    expect(parseDmReply("accept https://youtu.be/aaaaaaaaaaa")).toEqual({ kind: "accept" });
  });

  it("parses replace <n> <url> (v1.1 1.6), case-insensitive", () => {
    expect(parseDmReply("replace 3 https://youtu.be/dQw4w9WgXcQ")).toEqual({
      kind: "replace",
      position: 3,
      url: "https://youtu.be/dQw4w9WgXcQ",
    });
    expect(parseDmReply("Replace 12 https://www.youtube.com/watch?v=aaaaaaaaaaa")).toEqual({
      kind: "replace",
      position: 12,
      url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    });
  });

  it("replace without a URL falls through to unknown", () => {
    expect(parseDmReply("replace 3")).toEqual({ kind: "unknown" });
  });

  it("replace wins over embedded bare link when both present", () => {
    const r = parseDmReply("replace 2 https://youtu.be/aaaaaaaaaaa");
    expect(r).toMatchObject({ kind: "replace", position: 2 });
  });
});
