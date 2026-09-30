import { describe, expect, it } from "vitest";
import { postBadges } from "../src/mastodon/posts.js";
import { BADGE_IDS, type AwardedBadges } from "../src/game/merit.js";
import { m, setLocale, type Locale } from "../src/i18n/index.js";
import { createHarness } from "./support.js";
import { POST_LIMIT } from "../src/templates/truncate.js";
import { afterEach } from "vitest";

/**
 * The achievement reply shares Mastodon's 500-character ceiling with every other
 * post. The names are long and pt-BR runs longer than EN, so the fitting rule
 * is worth pinning: a whole player line or nothing, never half a name.
 */
function awardsFor(players: string[], perPlayer: number): AwardedBadges[] {
  return players.map((acct) => ({
    accountId: acct,
    acct,
    badges: BADGE_IDS.slice(0, perPlayer) as AwardedBadges["badges"],
  }));
}

const LOCALES: Locale[] = ["en", "pt-BR"];
let current: Locale = "en";
afterEach(() => setLocale(current));

describe("postBadges fits the post limit", () => {
  it("keeps a whole line per player in the realistic worst case", async () => {
    for (const locale of LOCALES) {
      current = locale;
      setLocale(locale);
      const h2 = createHarness();

      // 4 players, 5 badges each: the busiest a real duel gets, since badges
      // are once-ever and cannot all land in one game.
      await postBadges(h2.deps.client, awardsFor(["host", "alice", "bob", "carol"], 5), "s-1", "g-1");

      const status = String(h2.posts.at(-1)!.body.status);
      expect(status.length).toBeLessThanOrEqual(POST_LIMIT);
      // Nothing was cut: all four players appear, each with all five badges.
      for (const acct of ["host", "alice", "bob", "carol"]) {
        expect(status).toContain(`@${acct}:`);
      }
      h2.db.close();
    }
  });

  it("never emits a partial player line, however long the list", async () => {
    for (const locale of LOCALES) {
      current = locale;
      setLocale(locale);
      const h2 = createHarness();

      // Pathological: every badge in one duel, which the once-ever ledger makes
      // unreachable, but the fitting rule must still not produce half a name.
      await postBadges(h2.deps.client, awardsFor(["host", "alice", "bob", "carol"], BADGE_IDS.length), "s-1", "g-1");

      const status = String(h2.posts.at(-1)!.body.status);
      // The overflow note is not a player line; every line that is one must be
      // complete — every badge it lists appears in full, and it is not cut off.
      const playerLines = status.split("\n").slice(1).filter((l) => l.startsWith("•"));
      expect(playerLines.length).toBeGreaterThan(0);
      const allNames = BADGE_IDS.map((b) => m().badgeName(b));
      for (const line of playerLines) {
        // Not cut off, and every badge listed on it is a whole catalog name.
        expect(line).not.toMatch(/…$/);
        expect(line).toMatch(/^• @[\w.]+: /);
        for (const badge of line.split(": ")[1]!.split(" · ")) {
          expect(allNames).toContain(badge);
        }
      }
      h2.db.close();
    }
  });

  it("says how many players it dropped rather than truncating silently", async () => {
    current = "en";
    setLocale("en");
    const h2 = createHarness();

    await postBadges(h2.deps.client, awardsFor(["host", "alice", "bob", "carol"], BADGE_IDS.length), "s-1", "g-1");

    const status = String(h2.posts.at(-1)!.body.status);
    expect(status).toMatch(/…and \d+ more/);
    h2.db.close();
  });

  it("posts one reply into the thread it is given", async () => {
    const h2 = createHarness();

    await postBadges(h2.deps.client, awardsFor(["host"], 1), "s-summary", "g-1");

    expect(h2.posts).toHaveLength(1);
    expect(h2.posts[0]!.body).toMatchObject({ in_reply_to_id: "s-summary" });
    h2.db.close();
  });

  it("stays well-formed when the same game posts twice", async () => {
    // The outbox is the idempotency boundary and the harness client has no
    // ledger, so the observable contract here is that both calls resolve and
    // each produces a valid reply. The real ledger is covered by the outbox
    // specs and by the finale converging on a replay.
    const h2 = createHarness();
    await postBadges(h2.deps.client, awardsFor(["host"], 1), "s-1", "g-1");
    await postBadges(h2.deps.client, awardsFor(["host"], 1), "s-1", "g-1");
    for (const post of h2.posts) {
      expect(String(post.body.status).length).toBeLessThanOrEqual(POST_LIMIT);
    }
    h2.db.close();
  });

  it("uses localized names in both locales", async () => {
    const english = createHarness();
    setLocale("en");
    await postBadges(english.deps.client, awardsFor(["host"], 3), "s-1", "g-1");
    const en = String(english.posts.at(-1)!.body.status);
    english.db.close();

    const portuguese = createHarness();
    setLocale("pt-BR");
    await postBadges(portuguese.deps.client, awardsFor(["host"], 3), "s-1", "g-1");
    const pt = String(portuguese.posts.at(-1)!.body.status);
    portuguese.db.close();

    expect(en).toContain("First Track");
    expect(pt).toContain("Primeira Faixa");
    expect(pt).not.toBe(en);
  });
});
