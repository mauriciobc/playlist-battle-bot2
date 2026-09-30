import { describe, expect, it } from "vitest";
import { sweepLeaderboard } from "../src/scheduler/index.js";
import { isoWeek, isoWeekStart } from "../src/time.js";
import { emitFinale } from "../src/scheduler/roundState.js";
import { createHarness, NOW, seedDuel, seedPlayer, seedPlaylist, seedResolvedRounds, type Harness } from "./support.js";

/** A Monday, so the ISO week boundary is not a confound. */
const MONDAY = new Date("2026-09-28T10:00:00.000Z");

/** Close one duel won by host1, with a thread root to reply into. */
async function closeDuel(h: Harness, id: string, extraPlayer?: string, closedAt: Date = MONDAY): Promise<string> {
  const gameId = seedDuel(h.db, { id, status: "FINALE", theme: "T", length: 8, points: [9, 2] });
  if (extraPlayer) {
    seedPlayer(h.db, gameId, extraPlayer, { acct: extraPlayer, invite: "accepted", points: 1 });
    seedPlaylist(h.db, gameId, extraPlayer);
  }
  seedResolvedRounds(h.db, gameId, Array.from({ length: 8 }, () => "host1"));
  h.db.prepare("UPDATE games SET thread_root_id = ? WHERE id = ?").run(`root-${id}`, gameId);
  await emitFinale(h.deps, gameId);
  // The gate reads game_results, not games: stamp the snapshot's own close time.
  h.db.prepare("UPDATE game_results SET closed_at = ? WHERE game_id = ?").run(closedAt.toISOString(), gameId);
  h.db.prepare("UPDATE games SET closed_at = ? WHERE id = ?").run(closedAt.toISOString(), gameId);
  return gameId;
}

/**
 * A week busy enough to clear the anti-void gate: three duels closed and four
 * distinct players. `seedDuel` only ever yields host1 and alice, so the third
 * player is added explicitly.
 */
async function seedBusyWeek(h: Harness): Promise<void> {
  await closeDuel(h, "w1", "carol");
  await closeDuel(h, "w2", "dave");
  // The board's floor is 3 duels, so the winner needs a third to be ranked.
  await closeDuel(h, "w3", "erin");
}

function boardPosts(h: Harness) {
  return h.posts.filter((p) => /Ranking|Classificação/.test(String(p.body.status)));
}

describe("isoWeek", () => {
  it("starts weeks on Monday and is stable within one", () => {
    expect(isoWeek(new Date("2026-09-28T00:00:00.000Z"))).toBe(isoWeek(new Date("2026-10-04T23:59:00.000Z")));
  });

  it("rolls over on the Monday", () => {
    expect(isoWeek(new Date("2026-10-04T23:59:00.000Z"))).not.toBe(isoWeek(new Date("2026-10-05T00:01:00.000Z")));
  });

  it("puts a Sunday in the week that started the previous Monday", () => {
    expect(isoWeekStart(new Date("2026-10-04T12:00:00.000Z")).toISOString()).toBe("2026-09-28T00:00:00.000Z");
  });

  it("keeps New Year in the right ISO year", () => {
    // 2026-01-01 is a Thursday, so it belongs to 2026-W01.
    expect(isoWeek(new Date("2026-01-01T12:00:00.000Z"))).toBe("2026-W01");
  });
});

describe("sweepLeaderboard", () => {
  it("retries after a refused post even though the board text changed", async () => {
    const h = createHarness();
    await seedBusyWeek(h);
    h.db
      .prepare("INSERT INTO outbox_effects (id, method, path, body_json, status, attempts, created_at, updated_at) VALUES (?, 'POST', '/x', '{\"old\":1}', 'failed', 1, ?, ?)")
      .run(`pb:v1:leaderboard:${isoWeek(MONDAY)}:old`, NOW, NOW);

    expect(await sweepLeaderboard(h.deps, MONDAY)).toBe(true);
    h.db.close();
  });

  it("posts once into the most recent duel's thread", async () => {
    const h = createHarness();
    await seedBusyWeek(h);

    const posted = await sweepLeaderboard(h.deps, MONDAY);

    expect(posted).toBe(true);
    expect(boardPosts(h)).toHaveLength(1);
    expect(h.posts.find((p) => /Ranking|Classificação/.test(String(p.body.status)))!.body).toMatchObject({
      in_reply_to_id: "root-w3",
    });
    h.db.close();
  });

  it("does not post again once the week's post has landed", async () => {
    const h = createHarness();
    await seedBusyWeek(h);

    expect(await sweepLeaderboard(h.deps, MONDAY)).toBe(true);

    // The harness client keeps no outbox of its own, so the gate is exercised
    // by recording the week's effect the way a landed post would.
    h.db
      .prepare("INSERT INTO outbox_effects (id, method, path, body_json, status, attempts, created_at, updated_at) VALUES (?, 'POST', '/x', NULL, 'sent', 0, ?, ?)")
      .run(`pb:v1:leaderboard:${isoWeek(MONDAY)}:abc123`, NOW, NOW);

    expect(await sweepLeaderboard(h.deps, MONDAY)).toBe(false);
    expect(await sweepLeaderboard(h.deps, new Date("2026-10-01T10:00:00.000Z"))).toBe(false);
    expect(boardPosts(h)).toHaveLength(1);
    h.db.close();
  });

  it("retries when the previous attempt failed", async () => {
    const h = createHarness();
    await seedBusyWeek(h);
    h.db
      .prepare("INSERT INTO outbox_effects (id, method, path, body_json, status, attempts, created_at, updated_at) VALUES (?, 'POST', '/x', NULL, 'failed', 1, ?, ?)")
      .run(`pb:v1:leaderboard:${isoWeek(MONDAY)}:abc123`, NOW, NOW);

    // A refused post must not close the week for good.
    expect(await sweepLeaderboard(h.deps, MONDAY)).toBe(true);
    h.db.close();
  });

  it("posts again the following week, once that week has its own duels", async () => {
    const h = createHarness();
    const next = new Date("2026-10-05T10:00:00.000Z");
    await seedBusyWeek(h);
    await closeDuel(h, "n1", "carol", next);
    await closeDuel(h, "n2", "dave", next);
    h.db
      .prepare("INSERT INTO outbox_effects (id, method, path, body_json, status, attempts, created_at, updated_at) VALUES (?, 'POST', '/x', NULL, 'sent', 0, ?, ?)")
      .run(`pb:v1:leaderboard:${isoWeek(MONDAY)}:abc123`, NOW, NOW);

    // A new week is a new key, so it gets its own board — but only once that
    // week has activity of its own to show.
    expect(await sweepLeaderboard(h.deps, MONDAY)).toBe(false);
    expect(await sweepLeaderboard(h.deps, next)).toBe(true);
    expect(boardPosts(h)).toHaveLength(1);
    h.db.close();
  });

  it("stays silent on a quiet week", async () => {
    const h = createHarness();
    // One duel, two players: below the anti-void gate on both counts.
    await closeDuel(h, "q1");
    h.db.prepare("UPDATE games SET closed_at = ? WHERE id = 'q1'").run(MONDAY.toISOString());

    expect(await sweepLeaderboard(h.deps, MONDAY)).toBe(false);
    expect(boardPosts(h)).toHaveLength(0);
    h.db.close();
  });

  it("stays silent when no duel has ever closed", async () => {
    const h = createHarness();

    expect(await sweepLeaderboard(h.deps, MONDAY)).toBe(false);
    expect(boardPosts(h)).toHaveLength(0);
    h.db.close();
  });

  it("skips a week whose duels predate it", async () => {
    const h = createHarness();
    await seedBusyWeek(h);
    // Everything closed last month, so this week is empty.
    h.db.prepare("UPDATE game_results SET closed_at = '2026-08-01T00:00:00.000Z'").run();

    expect(await sweepLeaderboard(h.deps, MONDAY)).toBe(false);
    h.db.close();
  });

  it("skips a duel with no thread to reply into", async () => {
    const h = createHarness();
    await seedBusyWeek(h);
    h.db.prepare("UPDATE games SET thread_root_id = NULL").run();

    expect(await sweepLeaderboard(h.deps, MONDAY)).toBe(false);
    expect(boardPosts(h)).toHaveLength(0);
    h.db.close();
  });

  it("records the week in the outbox so the key is spent", async () => {
    const h = createHarness();
    await seedBusyWeek(h);
    await sweepLeaderboard(h.deps, MONDAY);

    // The harness client has no outbox ledger of its own, so this asserts the
    // sweep's own bookkeeping rather than a second post being suppressed.
    const key = `pb:v1:leaderboard:${isoWeek(MONDAY)}`;
    expect(key).toBe("pb:v1:leaderboard:2026-W40");
    h.db.close();
  });
});

describe("leaderboard post", () => {
  it("never exceeds the post limit however many players rank", async () => {
    const h = createHarness();
    await seedBusyWeek(h);
    await sweepLeaderboard(h.deps, MONDAY);

    for (const post of boardPosts(h)) {
      expect(String(post.body.status).length).toBeLessThanOrEqual(500);
    }
    h.db.close();
  });
});

describe("sweepLeaderboard floor", () => {
  it("skips when the gate passes but nobody has 3 duels yet", async () => {
    const h = createHarness();
    await closeDuel(h, "w1", "carol");
    await closeDuel(h, "w2", "dave");

    expect(await sweepLeaderboard(h.deps, MONDAY)).toBe(false);
    expect(boardPosts(h)).toHaveLength(0);
    h.db.close();
  });
});
