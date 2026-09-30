import { describe, expect, it, vi } from "vitest";
import { emitFinale } from "../src/scheduler/roundState.js";
import { drainAnnouncements, announcementBackoffMs } from "../src/scheduler/announcements.js";
import { resumeOpenGames } from "../src/scheduler/index.js";
import { MastodonApiError } from "../src/mastodon/client.js";
import { createHarness, gameRow, seedDuel, seedResolvedRounds, NOW, type Harness } from "./support.js";

type Row = { kind: string; account_id: string; status: string; attempts: number; next_attempt_at: string; last_error: string | null };

const rows = (h: Harness, gameId: string) =>
  h.db.prepare("SELECT * FROM merit_announcements WHERE game_id = ? ORDER BY kind DESC, account_id").all(gameId) as Row[];

function finaleGame(h: Harness): string {
  const gameId = seedDuel(h.db, { status: "FINALE", theme: "T", length: 8, points: [9, 2] });
  seedResolvedRounds(h.db, gameId, Array.from({ length: 8 }, () => "host1"));
  return gameId;
}

/** Make sends matching `match` fail with `err` until `state.failing` is cleared. */
function failSends(h: Harness, match: (body: Record<string, unknown>) => boolean, err: Error) {
  const state = { failing: true, attempts: 0 };
  const real = h.deps.client.post.bind(h.deps.client);
  h.deps.client.post = (async (path: string, body?: Record<string, unknown>, options?: unknown) => {
    if (state.failing && body && match(body)) {
      state.attempts += 1;
      throw err;
    }
    return real(path, body as never, options as never);
  }) as typeof h.deps.client.post;
  return state;
}

const isThreadReply = (b: Record<string, unknown>) => /Achievements unlocked/.test(String(b.status));
const isDm = (b: Record<string, unknown>) => b.visibility === "direct";

describe("merit announcement queue", () => {
  it("closes the game even when the thread reply keeps failing, and retries it", async () => {
    const h = createHarness();
    const gameId = finaleGame(h);
    const failing = failSends(h, isThreadReply, new Error("connection reset"));

    await emitFinale(h.deps, gameId);

    expect(gameRow(h.db, gameId).status).toBe("CLOSED");
    const thread = rows(h, gameId).find((r) => r.kind === "thread")!;
    expect(thread).toMatchObject({ status: "pending", attempts: 1, last_error: "connection reset" });
    // The DMs were independent of the failing thread reply.
    expect(rows(h, gameId).filter((r) => r.kind === "dm").every((r) => r.status === "sent")).toBe(true);

    // Not due yet: nothing is attempted before the backoff elapses.
    await drainAnnouncements(h.deps, gameId);
    expect(failing.attempts).toBe(1);

    // Once due and the network is back, it lands and the row closes.
    failing.failing = false;
    h.deps.now = () => new Date(Date.parse(thread.next_attempt_at) + 1000);
    await resumeOpenGames(h.sched);
    expect(rows(h, gameId).find((r) => r.kind === "thread")!.status).toBe("sent");
    expect(h.posts.filter((p) => isThreadReply(p.body))).toHaveLength(1);
    h.db.close();
  });

  it("abandons a refusal a retry cannot fix, at once, without touching other rows", async () => {
    const h = createHarness();
    const gameId = finaleGame(h);
    failSends(h, isThreadReply, new MastodonApiError(422, "parent gone"));

    await emitFinale(h.deps, gameId);

    const all = rows(h, gameId);
    expect(all.find((r) => r.kind === "thread")).toMatchObject({ status: "abandoned", attempts: 1 });
    expect(all.filter((r) => r.kind === "dm").every((r) => r.status === "sent")).toBe(true);
    h.db.close();
  });

  it("gives up after the attempt cap and logs it", async () => {
    const h = createHarness();
    h.deps.announceMaxAttempts = 3;
    const warn = vi.fn();
    h.deps.logger = { info: vi.fn(), warn, debug: vi.fn(), error: vi.fn() } as unknown as NonNullable<typeof h.deps.logger>;
    const gameId = finaleGame(h);
    failSends(h, isDm, new Error("timeout"));

    let clock = Date.parse(NOW);
    h.deps.now = () => new Date(clock);
    await emitFinale(h.deps, gameId);
    for (let i = 0; i < 4; i += 1) {
      clock += 7 * 60 * 60 * 1000; // past any backoff
      await drainAnnouncements(h.deps);
    }

    const dm = rows(h, gameId).filter((r) => r.kind === "dm");
    expect(dm.every((r) => r.status === "abandoned" && r.attempts === 3)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "dm", attempts: 3 }),
      expect.stringContaining("abandoned"),
    );
    h.db.close();
  });

  it("retries a rate limit instead of abandoning it", async () => {
    const h = createHarness();
    const gameId = finaleGame(h);
    failSends(h, isThreadReply, new MastodonApiError(429, "slow down"));

    await emitFinale(h.deps, gameId);

    expect(rows(h, gameId).find((r) => r.kind === "thread")!.status).toBe("pending");
    h.db.close();
  });

  it("backs off exponentially from one minute, capped", () => {
    expect(announcementBackoffMs(1)).toBe(60_000);
    expect(announcementBackoffMs(2)).toBe(120_000);
    expect(announcementBackoffMs(3)).toBe(240_000);
    expect(announcementBackoffMs(30)).toBe(6 * 60 * 60 * 1000);
  });
});

describe("resumeStuckFinales isolation", () => {
  it("keeps going past a finale that throws", async () => {
    const h = createHarness();
    const bad = seedDuel(h.db, { id: "bad", status: "FINALE", theme: "Doomed", length: 8, points: [9, 2] });
    seedResolvedRounds(h.db, bad, Array.from({ length: 8 }, () => "host1"));
    const good = seedDuel(h.db, { id: "good", status: "FINALE", theme: "Fine", length: 8, points: [9, 2] });
    seedResolvedRounds(h.db, good, Array.from({ length: 8 }, () => "host1"));
    const failing = failSends(h, (b) => /Doomed/.test(String(b.status)) && !isDm(b), new Error("boom"));

    await resumeOpenGames(h.sched);

    expect(failing.attempts).toBeGreaterThan(0);
    expect(gameRow(h.db, bad).status).toBe("FINALE");
    expect(gameRow(h.db, good).status).toBe("CLOSED");
    h.db.close();
  });
});
