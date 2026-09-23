import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, migrate, type Db } from "../src/db/index.js";
import { TERMINAL_STATUSES } from "../src/game/types.js";
import {
  lastHostedCreation,
  openGamesForAccount,
  releasePendingNotificationClaims,
} from "../src/game/store.js";

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pb-store-"));
  db = openDatabase(join(dir, "test.db"));
  migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedGame(opts: {
  id: string;
  status?: string;
  hostAccountId?: string;
  createdAt?: string;
}): void {
  const at = opts.createdAt ?? "2026-09-21T12:00:00.000Z";
  db.prepare(
    `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec,
      thread_root_id, current_round, pot, created_at, updated_at)
     VALUES (?, ?, 'T', 8, ?, 86400, 'root-1', 0, 0, ?, ?)`,
  ).run(opts.id, opts.status ?? "ROUND", opts.hostAccountId ?? "a", at, at);
}

function seedParticipant(gameId: string, accountId: string, role: "host" | "challenger" = "challenger"): void {
  db.prepare(
    `INSERT INTO players (game_id, account_id, acct, role, invite_status, points) VALUES (?, ?, ?, ?, 'accepted', 0)`,
  ).run(gameId, accountId, accountId, role);
}

describe("openGamesForAccount", () => {
  it("counts games the account joined as a challenger, not only games it hosts", () => {
    seedGame({ id: "hosted-by-a", hostAccountId: "a" });
    seedParticipant("hosted-by-a", "a", "host");

    seedGame({ id: "joined-by-a", hostAccountId: "b" });
    seedParticipant("joined-by-a", "b", "host");
    seedParticipant("joined-by-a", "a");

    seedGame({ id: "unrelated", hostAccountId: "b" });
    seedParticipant("unrelated", "b", "host");

    expect(openGamesForAccount(db, "a").map((g) => g.id).sort()).toEqual(["hosted-by-a", "joined-by-a"]);
    expect(openGamesForAccount(db, "b").map((g) => g.id).sort()).toEqual(["joined-by-a", "unrelated"]);
  });

  it("excludes games in every terminal status", () => {
    seedGame({ id: "still-open", status: "COLLECTING" });
    seedParticipant("still-open", "a", "host");
    for (const status of TERMINAL_STATUSES) {
      seedGame({ id: `closed-${status}`, status });
      seedParticipant(`closed-${status}`, "a", "host");
    }

    expect(openGamesForAccount(db, "a").map((g) => g.id)).toEqual(["still-open"]);
  });

  it("returns nothing for an account in no games", () => {
    seedGame({ id: "someone-elses", hostAccountId: "b" });
    seedParticipant("someone-elses", "b", "host");

    expect(openGamesForAccount(db, "a")).toEqual([]);
  });
});

describe("lastHostedCreation", () => {
  it("returns the most recent game the account hosted", () => {
    seedGame({ id: "g-early", hostAccountId: "a", createdAt: "2026-01-01T00:00:00.000Z" });
    seedGame({ id: "g-late", hostAccountId: "a", createdAt: "2026-06-01T00:00:00.000Z" });

    expect(lastHostedCreation(db, "a")).toBe("2026-06-01T00:00:00.000Z");
  });

  it("ignores games the account only joined and games hosted by others", () => {
    seedGame({ id: "hosted", hostAccountId: "a", createdAt: "2026-01-01T00:00:00.000Z" });
    seedGame({ id: "joined", hostAccountId: "b", createdAt: "2026-12-01T00:00:00.000Z" });
    seedParticipant("joined", "a");

    expect(lastHostedCreation(db, "a")).toBe("2026-01-01T00:00:00.000Z");
  });

  it("returns null when the account has hosted nothing", () => {
    seedGame({ id: "joined", hostAccountId: "b" });
    seedParticipant("joined", "a");

    expect(lastHostedCreation(db, "a")).toBeNull();
  });
});

describe("releasePendingNotificationClaims", () => {
  it("drops mid-flight claims but keeps completed notifications", () => {
    const insert = db.prepare(
      "INSERT INTO processed_notifications (notification_id, processed_at) VALUES (?, ?)",
    );
    insert.run("in-flight", ""); // crashed between claim and completion
    insert.run("done-1", "2026-09-21T12:00:00.000Z");
    insert.run("done-2", "2026-09-21T12:00:01.000Z");

    releasePendingNotificationClaims(db);

    const remaining = db
      .prepare("SELECT notification_id FROM processed_notifications ORDER BY notification_id")
      .all() as { notification_id: string }[];
    expect(remaining.map((r) => r.notification_id)).toEqual(["done-1", "done-2"]);
  });
});
