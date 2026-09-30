import { describe, expect, it } from "vitest";
import { emitFinale } from "../src/scheduler/roundState.js";
import { dmBadges } from "../src/mastodon/dm.js";
import { awardedBadges } from "../src/db/merit.js";
import { MastodonApiError } from "../src/mastodon/client.js";
import type { RequestOptions } from "../src/mastodon/client.js";
import {
  createHarness,
  gameRow,
  seedDuel,
  seedResolvedRounds,
} from "./support.js";
import { POST_LIMIT } from "../src/templates/truncate.js";

describe("badge DM", () => {
  it("names the badges and the running total", async () => {
    const h = createHarness();
    await dmBadges(h.deps, {
      gameId: "g1",
      accountId: "a",
      acct: "alice",
      badges: ["debut", "first_blood"],
      heldTotal: 7,
    });

    const text = String(h.posts.at(-1)!.body.status);
    expect(text).toContain("First Track");
    expect(text).toContain("First Hit");
    expect(text).toContain("7");
    expect(h.posts.at(-1)!.body).toMatchObject({ visibility: "direct" });
    expect(text.length).toBeLessThanOrEqual(POST_LIMIT);
    h.db.close();
  });

  it("addresses a local account with its bare handle", async () => {
    const h = createHarness();
    await dmBadges(h.deps, { gameId: "g1", accountId: "a", acct: "alice", badges: ["debut"], heldTotal: 1 });

    expect(String(h.posts.at(-1)!.body.status)).toMatch(/^@alice /);
    h.db.close();
  });
});

describe("finale DMs every awarded player", () => {
  it("sends one DM per player who earned something", async () => {
    const h = createHarness();
    const gameId = seedDuel(h.db, { status: "FINALE", theme: "T", length: 8, points: [9, 2] });
    seedResolvedRounds(h.db, gameId, Array.from({ length: 8 }, () => "host1"));

    await emitFinale(h.deps, gameId);

    const dms = h.posts.filter((p) => p.body.visibility === "direct");
    expect(dms).toHaveLength(2);
    expect(dms.map((d) => String(d.body.status).match(/^@(\S+)/)![1]).sort()).toEqual([
      "alice",
      "host1",
    ]);
    h.db.close();
  });

  it("still closes the game when a DM is refused", async () => {
    // A player with DMs from strangers off, or a deleted account, must not stop
    // the duel from closing: the public achievement reply already announced it.
    const h = createHarness();
    const gameId = seedDuel(h.db, { status: "FINALE", theme: "T", length: 8, points: [9, 2] });
    seedResolvedRounds(h.db, gameId, Array.from({ length: 8 }, () => "host1"));

    const failing = h.deps.client.post.bind(h.deps.client);
    h.deps.client.post = (async (path: string, body?: unknown, options?: RequestOptions) => {
      const visibility =
        typeof body === "object" && body !== null && "visibility" in body ? body.visibility : undefined;
      if (path === "/api/v1/statuses" && visibility === "direct") {
        throw new MastodonApiError(403, "blocked");
      }
      return failing(path, body, options);
    }) as typeof h.deps.client.post;

    await emitFinale(h.deps, gameId);

    expect(gameRow(h.db, gameId).status).toBe("CLOSED");
    expect(awardedBadges(h.db, "host1").size).toBeGreaterThan(0);
    // The public reply still went out.
    expect(h.posts.some((p) => /Achievements unlocked/.test(String(p.body.status)))).toBe(true);
    h.db.close();
  });

  it("sends no DM to a player who earned nothing new", async () => {
    const h = createHarness();
    const gameId = seedDuel(h.db, { status: "FINALE", theme: "T", length: 8, points: [9, 2] });
    seedResolvedRounds(h.db, gameId, Array.from({ length: 8 }, () => "host1"));

    await emitFinale(h.deps, gameId);
    const afterFirst = h.posts.length;

    // A replay finds nothing new to award, so it must not re-DM anyone.
    await emitFinale(h.deps, gameId);
    expect(h.posts.length).toBe(afterFirst);
    h.db.close();
  });
});
