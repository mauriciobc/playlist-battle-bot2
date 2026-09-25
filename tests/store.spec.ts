import { describe, expect, it } from "vitest";
import { TERMINAL_STATUSES } from "../src/game/types.js";
import {
  deferUntilNotifications,
  lastHostedCreation,
  openGamesForAccount,
  recordNotificationFailure,
  releasePendingNotificationClaims,
} from "../src/game/store.js";
import { NOW, seedGame, seedPlayer, useHarness } from "./support.js";

const h = useHarness();

/** A game hosted (and joined) by `host`, plus any challengers. */
function hosted(id: string, host: string, o: { status?: string; createdAt?: string; challengers?: string[] } = {}) {
  seedGame(h.db, { id, host, status: o.status ?? "ROUND", createdAt: o.createdAt ?? NOW });
  for (const accountId of [host, ...(o.challengers ?? [])]) seedPlayer(h.db, id, accountId);
}

const openIds = (accountId: string) => openGamesForAccount(h.db, accountId).map((g) => g.id).sort();

describe("openGamesForAccount", () => {
  it("counts games the account joined as a challenger, not only games it hosts", () => {
    hosted("hosted-by-a", "a");
    hosted("joined-by-a", "b", { challengers: ["a"] });
    hosted("unrelated", "b");

    expect(openIds("a")).toEqual(["hosted-by-a", "joined-by-a"]);
    expect(openIds("b")).toEqual(["joined-by-a", "unrelated"]);
    expect(openIds("c")).toEqual([]);
  });

  it("excludes games in every terminal status", () => {
    hosted("still-open", "a", { status: "COLLECTING" });
    for (const status of TERMINAL_STATUSES) hosted(`closed-${status}`, "a", { status });

    expect(openIds("a")).toEqual(["still-open"]);
  });
});

describe("lastHostedCreation", () => {
  it("returns the most recent game the account hosted, ignoring games it only joined", () => {
    hosted("g-early", "a", { createdAt: "2026-01-01T00:00:00.000Z" });
    hosted("g-late", "a", { createdAt: "2026-06-01T00:00:00.000Z" });
    hosted("joined", "b", { createdAt: "2026-12-01T00:00:00.000Z", challengers: ["a"] });

    expect(lastHostedCreation(h.db, "a")).toBe("2026-06-01T00:00:00.000Z");
  });

  it("returns null when the account has hosted nothing", () => {
    hosted("joined", "b", { challengers: ["a"] });

    expect(lastHostedCreation(h.db, "a")).toBeNull();
  });
});

describe("releasePendingNotificationClaims", () => {
  it("drops mid-flight claims but keeps completed notifications", () => {
    const insert = h.db.prepare("INSERT INTO processed_notifications (notification_id, processed_at) VALUES (?, ?)");
    insert.run("in-flight", ""); // crashed between claim and completion
    insert.run("done-1", "2026-09-21T12:00:00.000Z");
    insert.run("done-2", "2026-09-21T12:00:01.000Z");

    releasePendingNotificationClaims(h.db);

    expect(
      h.db.prepare("SELECT notification_id FROM processed_notifications ORDER BY notification_id").all(),
    ).toEqual([{ notification_id: "done-1" }, { notification_id: "done-2" }]);
  });
});

/**
 * next_attempt_at was once written on every rate-limited failure and never
 * read: the poller re-ran the same notification each tick, and every rejected
 * POST refreshed the very window being waited out.
 */
describe("deferUntilNotifications", () => {
  it("holds a rate-limited notification until its reset, then releases it", () => {
    recordNotificationFailure(h.db, "limited", 1, "rate limit exhausted", "2026-09-24T14:05:00.000Z", null);

    expect([...deferUntilNotifications(h.db, new Date("2026-09-24T14:00:00.000Z"))]).toEqual(["limited"]);
    expect([...deferUntilNotifications(h.db, new Date("2026-09-24T14:06:00.000Z"))]).toEqual([]);
  });

  it("never defers dead-lettered or unscheduled failures", () => {
    recordNotificationFailure(h.db, "dead", 3, "poison", "2099-01-01T00:00:00.000Z", "2026-09-24T14:00:00.000Z");
    recordNotificationFailure(h.db, "plain", 1, "boom", null, null);

    expect(deferUntilNotifications(h.db, new Date("2026-09-24T14:00:00.000Z")).size).toBe(0);
  });
});
