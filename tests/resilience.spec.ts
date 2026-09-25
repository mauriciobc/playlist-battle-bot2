import { describe, expect, it, vi } from "vitest";
import { processNotification } from "../src/handlers/mention.js";
import { handlePlayerDeleted } from "../src/handlers/closure.js";
import { readCursor, recordNotificationFailure, writeCursor } from "../src/game/store.js";
import { initializeNotificationCursor, pollNotifications } from "../src/mastodon/poller.js";
import { RateLimitError, type MastodonClient } from "../src/mastodon/client.js";
import { m } from "../src/i18n/index.js";
import {
  count,
  FUTURE,
  gameRow,
  mentionNotification,
  NOW,
  pollExpiredNotification,
  roundRow,
  seedDuel,
  seedGame,
  seedPlayer,
  seedPollRound,
  useHarness,
} from "./support.js";

const STATUS = "<p>@playlistbattle status</p>";

describe("notification pipeline resilience", () => {
  const h = useHarness();
  const processed = (id: string) =>
    h.db.prepare("SELECT attempts, processed_at FROM processed_notifications WHERE notification_id = ?").get(id) as
      | { attempts: number; processed_at: string }
      | undefined;

  describe("creation post failure → retry never duplicates the game", () => {
    it("persists a creation before invite effects and resumes it without duplicates", async () => {
      const n = mentionNotification("700", '<p>@playlistbattle newgame "X" 8 @alice @bob</p>');
      // the creation reply lands, the first invite DM fails
      h.client.post
        .mockImplementationOnce(h.client.post.getMockImplementation()!)
        .mockRejectedValueOnce(new Error("DM send failed"));

      h.inbox.push(n);
      await expect(pollNotifications(h.deps)).rejects.toThrow(/DM send failed/);
      expect(gameRow(h.db, "game-1").status).toBe("CREATED");

      h.inbox.push(n);
      await pollNotifications(h.deps);

      expect(count(h.db, "games")).toBe(1);
      expect(count(h.db, "players")).toBe(3);
      expect(h.posts.filter((p) => p.body.in_reply_to_id === "s700")).toHaveLength(1);
      expect(gameRow(h.db, "game-1")).toMatchObject({ status: "INVITED", thread_root_id: expect.any(String) });
    });

    it("persistent post failure exhausts retries then marks the notification poison", async () => {
      const n = mentionNotification("801", '<p>@playlistbattle newgame "X" 8 @alice</p>');
      for (let i = 0; i < 3; i += 1) h.client.post.mockRejectedValueOnce(new Error("HTTP 500"));

      // attempts 1–2 release the claim and rethrow (retry); attempt 3 marks it poison and resolves
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        h.inbox.push(n);
        const run = expect(pollNotifications(h.deps));
        await (attempt < 3 ? run.rejects.toThrow(/HTTP 500/) : run.resolves.toBeUndefined());
      }
      expect(processed("801")).toEqual({ attempts: 3, processed_at: "error" });

      // poison is terminal: re-polling is a no-op with no retries
      h.inbox.push(n);
      await pollNotifications(h.deps);
      expect(processed("801")?.attempts).toBe(3);
      expect(h.client.post).toHaveBeenCalledTimes(3);

      // an earlier poison does not block later notifications in the same page
      h.inbox.push(n, mentionNotification("802", STATUS));
      await pollNotifications(h.deps);
      expect(h.posts).toHaveLength(1); // the later mention was handled
      expect(readCursor(h.db).lastId).toBe("802"); // cursor advanced past the poison
    });
  });

  it("deleted player → their open games FORFEIT: pot voided, live poll removed, notice in thread; others untouched", async () => {
    const id = seedDuel(h.db, { currentRound: 2, pot: 2 });
    seedPollRound(h.db, id, { round: 2, statusId: "poll-status-1", expiresAt: FUTURE });
    const other = seedGame(h.db, { currentRound: 1 });
    seedPlayer(h.db, other, "host1");
    seedPlayer(h.db, other, "bob");

    const affected = await handlePlayerDeleted(h.deps, "alice");

    // v1.1 1.5: deletion takes precedence over a walkover — no champion, no pot
    expect(affected).toEqual([id]);
    expect(gameRow(h.db, id)).toMatchObject({ status: "FORFEIT", pot: 0 });
    expect(roundRow(h.db, id, 2)).toMatchObject({ status: "resolved", poll_status_id: null });
    expect(h.deleted).toEqual(["/api/v1/statuses/poll-status-1"]);
    expect(h.posts.map((p) => p.body)).toContainEqual(
      expect.objectContaining({ in_reply_to_id: "root-1", status: m().sideForfeit("Theme") }),
    );
    expect(gameRow(h.db, other).status).toBe("ROUND");
  });

  describe("crash-safe cursor advance", () => {
    it("does not advance cursor or mark processed when handler throws; retries succeed next poll", async () => {
      const n = mentionNotification("101", STATUS);
      h.client.post.mockRejectedValueOnce(new Error("network blip"));

      h.inbox.push(n);
      await expect(pollNotifications(h.deps)).rejects.toThrow(/network blip/);
      expect(readCursor(h.db).lastId).toBe("");
      expect(count(h.db, "processed_notifications")).toBe(0);

      // healed: the same notification is re-fetched (since_id still empty)
      h.inbox.push(n);
      await pollNotifications(h.deps);
      expect(readCursor(h.db).lastId).toBe("101");
      expect(count(h.db, "processed_notifications")).toBe(1);
      expect(h.posts).toHaveLength(1);
    });

    /** Two notification pages: 702 first, then 701 behind a `page=2` link. */
    function pagedDeps() {
      const getWithLink = vi.fn(async (path: string) =>
        path.includes("page=2")
          ? { data: [mentionNotification("701", STATUS)], linkNext: null }
          : { data: [mentionNotification("702", STATUS)], linkNext: "page=2" },
      );
      return { getWithLink, deps: { ...h.deps, client: { ...h.client, getWithLink } as unknown as MastodonClient } };
    }

    it("processes every notification page before finishing a poll", async () => {
      const { getWithLink, deps } = pagedDeps();

      await pollNotifications(deps);

      expect(getWithLink).toHaveBeenCalledTimes(2);
      expect(readCursor(h.db).lastId).toBe("702");
      expect(count(h.db, "processed_notifications")).toBe(2);
    });

    it("does not advance the cursor when a later notification page fails", async () => {
      const { deps } = pagedDeps();
      h.client.post
        .mockImplementationOnce(h.client.post.getMockImplementation()!)
        .mockRejectedValueOnce(new Error("page-two failure"));

      await expect(pollNotifications(deps)).rejects.toThrow(/page-two failure/);
      expect(readCursor(h.db).lastId).toBe("");
    });

    it("initializes a first-boot cursor without processing historical notifications", async () => {
      const getWithLink = vi.fn(async () => ({ data: [mentionNotification("800", STATUS)], linkNext: null }));

      await initializeNotificationCursor({ db: h.db, client: { ...h.client, getWithLink } as unknown as MastodonClient });

      expect(readCursor(h.db).lastId).toBe("800");
      expect(count(h.db, "processed_notifications")).toBe(0);
    });

    it("holds the cursor before a rate-limited notification until its reset, then moves past it", async () => {
      // The next poll asks since_id = cursor, so advancing past a deferred
      // notification drops it for good: in production the cursor landed on the
      // stuck id and the newgame it carried never became a game.
      writeCursor(h.db, { lastId: "100" });
      recordNotificationFailure(h.db, "101", 1, "rate limit exhausted", "2026-09-21T12:20:00.000Z", null);
      const tick = async (at: string) => {
        h.deps.now = () => new Date(at);
        h.inbox.push(mentionNotification("101", STATUS), mentionNotification("102", STATUS));
        await pollNotifications(h.deps);
      };

      for (const at of ["2026-09-21T12:10:00.000Z", "2026-09-21T12:14:00.000Z"]) {
        await tick(at);
        expect(readCursor(h.db).lastId).toBe("100");
        expect(h.posts).toHaveLength(0); // the later notification may not overtake it
      }

      await tick("2026-09-21T12:21:00.000Z");
      expect(readCursor(h.db).lastId).toBe("102");
      expect(h.posts).toHaveLength(2);
    });

    it("poll_expired notification resolves the round at once; a redelivery is a no-op", async () => {
      const id = seedDuel(h.db, { currentRound: 1, pot: 1 });
      seedPollRound(h.db, id);
      const n = pollExpiredNotification("500", "poll-status");

      await processNotification(n, h.deps);

      expect(gameRow(h.db, id)).toMatchObject({ current_round: 2, pot: 0 });
      expect(processed("500")?.processed_at).toBe(NOW);

      const postsAfterFirst = h.posts.length;
      await processNotification(n, h.deps);
      expect(h.posts).toHaveLength(postsAfterFirst);
      expect(gameRow(h.db, id).current_round).toBe(2); // not double-advanced
    });

    it("does not dead-letter a notification after repeated rate limits", async () => {
      const n = mentionNotification("602", STATUS);
      h.client.post.mockRejectedValue(new RateLimitError(Math.floor(Date.now() / 1000) + 300));

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(processNotification(n, h.deps)).rejects.toBeInstanceOf(RateLimitError);
      }

      const failure = () =>
        h.db.prepare("SELECT attempts, dead_lettered_at FROM notification_failures WHERE notification_id = ?").get(n.id);
      expect(failure()).toEqual({ attempts: 1, dead_lettered_at: null });
      h.client.post.mockRejectedValue(new Error("HTTP 500"));
      await expect(processNotification(n, h.deps)).rejects.toThrow(/HTTP 500/);
      expect(failure()).toMatchObject({ dead_lettered_at: null });
      expect(processed(n.id)).toBeUndefined();
    });

    it("overlapping deliveries of one notification produce exactly one side effect", async () => {
      const n = mentionNotification("601", STATUS);

      await Promise.all([processNotification(n, h.deps), processNotification(n, h.deps)]);

      expect(h.posts).toHaveLength(1); // second delivery claimed by the first
      expect(processed("601")?.processed_at).toBe(NOW); // completed, not left claimed
    });
  });
});
