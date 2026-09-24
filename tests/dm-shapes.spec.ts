import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { acctMatches } from "../test/integration/mastodon-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(here, "fixtures", "dm-shapes.json"), "utf-8"),
);

const BOT = "mauriciobc@mastodon.social";

/**
 * Regressions captured from real failed E2E runs.
 *
 * The two accounts share a local part - the bot is mauriciobc@mastodon.social
 * and the player is mauriciobc@ursal.zone - so anything that compares handles
 * without resolving the instance will treat the player's own submissions as
 * bot replies.
 */
describe("DM shapes seen in production", () => {
  describe("bot -> host (same instance)", () => {
    const f = fixtures.bot_acks_to_host_same_instance;

    it("reports the bot with a BARE acct, resolved against the viewer", () => {
      for (const m of f.messages) {
        expect(m.acct_reported).toBe("mauriciobc");
        expect(m.acct_reported).not.toContain("@");
        // The whole point: resolve the instance before comparing.
        expect(acctMatches(m.acct_reported, f.viewer_instance, BOT)).toBe(true);
      }
    });

    it("is not reachable from the host's conversations or notifications", () => {
      // Recorded because polling only these made the harness hang.
      for (const m of f.messages) {
        expect(m.hidden_from).toContain("conversations");
        expect(m.hidden_from).toContain("notifications");
        expect(m.visible_via).toContain("statuses/{id}");
      }
    });

    it("is a standalone DM, not a threaded reply", () => {
      for (const m of f.messages) {
        expect(m.in_reply_to_id).toBeNull();
      }
    });
  });

  describe("bot -> player (cross-instance)", () => {
    const f = fixtures.bot_acks_to_player_cross_instance;

    it("reports the bot fully qualified", () => {
      for (const m of f.messages) {
        expect(m.acct_reported).toBe(BOT);
        expect(acctMatches(m.acct_reported, f.viewer_instance, BOT)).toBe(true);
      }
    });

    it("is in conversations but 404s on direct fetch", () => {
      // The inverse of the same-instance case, so detection needs both paths.
      for (const m of f.messages) {
        expect(m.visible_via).toContain("conversations");
        expect(m.hidden_from).toContain("statuses/{id}");
      }
    });
  });

  describe("player's own submissions", () => {
    const f = fixtures.player_own_submissions;

    it("reports the player BARE, colliding with the bot's local part", () => {
      for (const m of f.messages) {
        // Same local part as the bot - this is the trap.
        expect(m.acct_reported.split("@")[0]).toBe(BOT.split("@")[0]);
        expect(m.acct_reported).not.toContain("@");
      }
    });

    it("does NOT match the bot once the instance is resolved", () => {
      for (const m of f.messages) {
        expect(acctMatches(m.acct_reported, f.viewer_instance, BOT)).toBe(false);
      }
    });
  });

  it("distinguishes the two same-named accounts in both directions", () => {
    const player = fixtures.player_own_submissions.messages[0];
    const host = fixtures.bot_acks_to_host_same_instance.messages[0];

    // Same local part, different servers, opposite verdicts.
    expect(host.acct_reported).toBe(player.acct_reported);
    expect(
      acctMatches(host.acct_reported, "mastodon.social", BOT),
    ).toBe(true);
    expect(
      acctMatches(player.acct_reported, "ursal.zone", BOT),
    ).toBe(false);
  });
});
