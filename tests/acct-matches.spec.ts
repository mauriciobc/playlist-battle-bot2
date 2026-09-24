import { describe, it, expect } from "vitest";
import { acctMatches } from "../test/integration/mastodon-helpers.js";

const BOT = "mauriciobc@mastodon.social";

/**
 * Mastodon appends the instance to an acct only when the account is REMOTE
 * relative to the instance doing the looking; a local account is reported as
 * a bare username. A bare acct therefore only identifies a user relative to
 * the viewer.
 *
 * In this suite the bot is mauriciobc@mastodon.social and the player is
 * mauriciobc@ursal.zone - same username, different people. Matching on the
 * username alone makes the player's own statuses look like the bot's.
 */
describe("acctMatches", () => {
  it("matches a bare acct against a same-instance target", () => {
    expect(acctMatches("mauriciobc", "mastodon.social", BOT)).toBe(true);
  });

  it("matches a qualified acct against a same-instance target", () => {
    expect(acctMatches("mauriciobc@mastodon.social", "mastodon.social", BOT)).toBe(true);
  });

  it("matches a remote acct seen from another instance", () => {
    expect(acctMatches("mauriciobc@mastodon.social", "ursal.zone", BOT)).toBe(true);
  });

  it("rejects a bare acct belonging to a different instance", () => {
    // The player's own acct as seen from the player's instance.
    expect(acctMatches("mauriciobc", "ursal.zone", BOT)).toBe(false);
  });

  it("rejects a qualified acct for a same-named user elsewhere", () => {
    expect(acctMatches("mauriciobc@ursal.zone", "ursal.zone", BOT)).toBe(false);
  });

  it("rejects a different user on the same instance", () => {
    expect(acctMatches("saiugol", "mastodon.social", BOT)).toBe(false);
  });

  it("tolerates a leading @ and ignores case", () => {
    expect(acctMatches("@MAURICIOBC", "MASTODON.SOCIAL", BOT)).toBe(true);
  });
});
