import { describe, expect, it } from "vitest";
import { parseCreateCommand, parseStatusCommand, parseDmReply, htmlToText } from "../src/handlers/commands.js";
import { m } from "../src/i18n/index.js";

const BOT = "playlistbattle";

describe("htmlToText", () => {
  it("decodes standard entities", () => {
    expect(htmlToText("<p>&lt;b&gt; &amp; bold &quot;quoted&quot;&#39;</p>")).toBe("<b> & bold \"quoted\"'");
  });

  it("does not double-decode (htmlToText('&amp;lt;') is the literal '&lt;')", () => {
    expect(htmlToText("&amp;lt;")).toBe("&lt;");
    expect(htmlToText("a &amp;amp; b")).toBe("a &amp; b");
  });

  it.each([
    [
      "same-instance",
      '<p><span class="h-card" translate="no"><a href="https://mastodon.social/@alice" class="u-url mention">@<span>alice</span></a></span> hello</p>',
      "@alice hello",
    ],
    [
      "cross-instance",
      '<p><span class="h-card" translate="no"><a href="https://ursal.zone/@alice" class="u-url mention">@<span>alice@ursal.zone</span></a></span> hello</p>',
      "@alice@ursal.zone hello",
    ],
    [
      "multiple (same + cross-instance)",
      '<p><a href="https://mastodon.social/@bot" class="u-url mention">@<span>bot</span></a> newgame "X" 8 <a href="https://ursal.zone/@alice" class="u-url mention">@<span>alice@ursal.zone</span></a></p>',
      '@bot newgame "X" 8 @alice@ursal.zone',
    ],
    [
      "mid-text",
      '<p>hey <a href="https://ursal.zone/@bob" class="u-url mention">@<span>bob@ursal.zone</span></a> check this out</p>',
      "hey @bob@ursal.zone check this out",
    ],
  ])("preserves @ prefixes of %s Mastodon mentions", (_case, html, expected) => {
    expect(htmlToText(html)).toBe(expected);
  });

  it("handles Mastodon mention HTML with invisible prefix spans", () => {
    const html = '<p><a href="https://ursal.zone/@alice" class="u-url mention"><span class="invisible">https://ursal.zone/</span><span>@alice@ursal.zone</span></a> hello</p>';
    expect(htmlToText(html)).toContain("@alice@ursal.zone");
  });
});

describe("parseCreateCommand", () => {
  it.each([
    [`@${BOT} newgame "80s Synth Wave" 8 @alice @bob`, { theme: "80s Synth Wave", playlistLength: 8, challengers: ["alice", "bob"] }],
    [`@${BOT} newgame 'Road Trip' 12 @carol`, { theme: "Road Trip", playlistLength: 12, challengers: ["carol"] }],
    // unquoted multi-word theme is greedy until the length; "90s" is not a length
    [`@${BOT} newgame best of 90s alternative 10 @dave`, { theme: "best of 90s alternative", playlistLength: 10, challengers: ["dave"] }],
    // the bot addressed by its remote-qualified handle
    [`@${BOT}@remote.social newgame "X" 8 @alice`, { theme: "X", playlistLength: 8, challengers: ["alice"] }],
  ])("parses %s", (text, expected) => {
    expect(parseCreateCommand(text, BOT)).toEqual(expected);
  });

  /**
   * A challenger may be written "user@instance" with no leading @. The
   * mention-only pattern began its capture at the "@" inside the handle, so
   * "mauriciobc@ursal.zone" parsed as "ursal" and the account lookup failed.
   */
  it.each([
    ["mauriciobc@ursal.zone", ["mauriciobc@ursal.zone"]],
    ["@mauriciobc@ursal.zone", ["mauriciobc@ursal.zone"]],
    ["alice", ["alice"]],
    ["@alice", ["alice"]],
    ["@a @b @c", ["a", "b", "c"]],
    ["@alice @bob@other.social", ["alice", "bob@other.social"]],
    ["alice@other.social @bob@third.social", ["alice@other.social", "bob@third.social"]],
    ["@a@mastodon.social @b@bsky.social @c@ursal.zone", ["a@mastodon.social", "b@bsky.social", "c@ursal.zone"]],
    // same local part as the bot on another instance is a different person
    [`@${BOT}@other.instance`, [`${BOT}@other.instance`]],
  ])("accepts challenger form %s", (arg, challengers) => {
    expect(parseCreateCommand(`@${BOT}@mastodon.social newgame "X" 8 ${arg}`, BOT, "mastodon.social")).toMatchObject({
      challengers,
    });
  });

  it.each<[string, string | undefined]>([
    [`@${BOT}`, undefined],
    [BOT, "mastodon.social"],
    [`@${BOT}@mastodon.social`, "mastodon.social"],
    [`${BOT}@other.social`, "other.social"],
  ])("never resolves the bot's own handle %s (instance %s) to a challenger", (arg, domain) => {
    expect(parseCreateCommand(`@${BOT} newgame "X" 8 ${arg}`, BOT, domain)).toEqual({ error: m().cmdTagChallenger() });
  });

  it.each([
    ["bad length", `@${BOT} newgame "X" 5 @a`, m().cmdLengthRange()],
    ["no challengers", `@${BOT} newgame "X" 8`, m().cmdTagChallenger()],
    ["too many challengers", `@${BOT} newgame "X" 8 @a @b @c @d`, m().cmdMaxChallengers()],
  ])("returns an error result for %s", (_case, text, error) => {
    expect(parseCreateCommand(text, BOT)).toEqual({ error });
  });

  it("returns null when the text is not a create command for this bot", () => {
    expect(parseCreateCommand(`@someoneElse newgame "X" 8 @a`, BOT)).toBeNull();
    expect(parseCreateCommand(`@${BOT} hello`, BOT)).toBeNull();
    expect(parseCreateCommand(`@${BOT} status`, BOT)).toBeNull();
  });
});

describe("parseStatusCommand", () => {
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

describe("parseDmReply (accept/decline/cancel/links/replace)", () => {
  it.each([
    ["accept", { kind: "accept" }],
    ["  ACCEPT ", { kind: "accept" }],
    ["Accept!", { kind: "accept" }],
    // Mastodon DMs start with the bot mention (reply/compose prefix)
    ["@playlistbattle accept", { kind: "accept" }],
    ["@playlistbattle@mastodon.example accept", { kind: "accept" }],
    ["@playlistbattle\naccept", { kind: "accept" }],
    // accept keyword wins over an embedded link
    ["accept https://youtu.be/aaaaaaaaaaa", { kind: "accept" }],
    ["Decline", { kind: "decline" }],
    ["@playlistbattle decline", { kind: "decline" }],
    ["  CANCEL ", { kind: "cancel" }],
    ["@playlistbattle cancel", { kind: "cancel" }],
    // a word merely starting with "cancel" is not the command
    ["cancellation", { kind: "unknown" }],
    ["what do I do?", { kind: "unknown" }],
    ["", { kind: "unknown" }],
    ["replace 3", { kind: "unknown" }],
    ["https://youtu.be/dQw4w9WgXcQ", { kind: "links", urls: ["https://youtu.be/dQw4w9WgXcQ"] }],
    ["@playlistbattle https://youtu.be/dQw4w9WgXcQ", { kind: "links", urls: ["https://youtu.be/dQw4w9WgXcQ"] }],
    // mixed lines: links extracted, non-link lines ignored
    ["here you go:\nhttps://youtu.be/aaaaaaaaaaa\nthanks!", { kind: "links", urls: ["https://youtu.be/aaaaaaaaaaa"] }],
    // v1.1 1.6, case-insensitive; replace wins over the bare link it contains
    ["replace 3 https://youtu.be/dQw4w9WgXcQ", { kind: "replace", position: 3, url: "https://youtu.be/dQw4w9WgXcQ" }],
    ["@playlistbattle Replace 12 https://youtu.be/dQw4w9WgXcQ", { kind: "replace", position: 12, url: "https://youtu.be/dQw4w9WgXcQ" }],
  ])("parses %j", (text, expected) => {
    expect(parseDmReply(text)).toEqual(expected);
  });

  it("parses one-per-line fast path (PRD §5.3)", () => {
    const urls = [
      "https://youtu.be/aaaaaaaaaaa",
      "https://www.youtube.com/watch?v=bbbbbbbbbbb",
      "https://music.youtube.com/watch?v=ccccccccccc",
    ];
    expect(parseDmReply(urls.join("\n"))).toEqual({ kind: "links", urls });
  });
});
