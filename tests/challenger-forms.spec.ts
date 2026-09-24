import { describe, it, expect } from "vitest";
import { parseCreateCommand } from "../src/handlers/commands.js";

const BOT = "mauriciobc";
const DOMAIN = "mastodon.social";

/**
 * A challenger may be written "user@instance" with no leading @.
 *
 * The mention-only pattern began its capture at the "@" *inside* the handle,
 * so "mauriciobc@ursal.zone" parsed as "ursal" and the account lookup failed
 * with 'Conta "ursal" não encontrada'. This cost several E2E runs before it
 * was caught.
 */
describe("parseCreateCommand challenger forms", () => {
  const cmd = (rest: string) =>
    parseCreateCommand(`@${BOT}@${DOMAIN} newgame ${rest}`, BOT, DOMAIN);

  it("accepts a fully qualified challenger with no leading @", () => {
    const r = cmd('"Rock" 8 mauriciobc@ursal.zone');
    expect(r).not.toBeNull();
    expect(r).toMatchObject({
      theme: "Rock",
      playlistLength: 8,
      challengers: ["mauriciobc@ursal.zone"],
    });
  });

  it("accepts a qualified challenger with a leading @", () => {
    const r = cmd('"Rock" 8 @mauriciobc@ursal.zone');
    expect(r).toMatchObject({ challengers: ["mauriciobc@ursal.zone"] });
  });

  it("accepts a bare username", () => {
    const r = cmd('"Rock" 8 alice');
    expect(r).toMatchObject({ challengers: ["alice"] });
  });

  it("accepts a bare username with a leading @", () => {
    const r = cmd('"Rock" 8 @alice');
    expect(r).toMatchObject({ challengers: ["alice"] });
  });

  it("keeps the theme when it contains spaces", () => {
    const r = cmd('"E2E Theme" 8 mauriciobc@ursal.zone');
    expect(r).toMatchObject({
      theme: "E2E Theme",
      challengers: ["mauriciobc@ursal.zone"],
    });
  });

  it("accepts several challengers", () => {
    const r = cmd('"Rock" 8 alice@other.social @bob@third.social');
    expect(r).toMatchObject({
      challengers: ["alice@other.social", "bob@third.social"],
    });
  });

  it("never resolves the bot's own handle to a challenger", () => {
    // Both bare and qualified forms of the bot must be filtered out.
    for (const arg of [BOT, `${BOT}@${DOMAIN}`]) {
      const r = cmd(`"Rock" 8 ${arg}`);
      expect(r).toMatchObject({ error: expect.any(String) });
    }
  });

  it("keeps a same-local-part person on another instance", () => {
    // The bot is mauriciobc@mastodon.social; mauriciobc@ursal.zone is a
    // different person and must remain a valid challenger.
    const r = cmd(`"Rock" 8 mauriciobc@ursal.zone`);
    expect(r).toMatchObject({ challengers: ["mauriciobc@ursal.zone"] });
  });
});
