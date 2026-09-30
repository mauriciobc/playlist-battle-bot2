import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, migrate, type Db } from "../src/db/index.js";
import {
  awardNewBadges,
  boardActivity,
  boardPosition,
  insertGameResult,
  insertParticipants,
  latestClosedGame,
  loadBoard,
  loadCareer,
  markGameClosed,
  meritAcct,
} from "../src/db/merit.js";
import { setGameStatus } from "../src/db/games.js";
import { seedGame, seedPlayer } from "./support.js";
import type { Player } from "../src/game/types.js";

let db: Db;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db);
});

afterEach(() => db.close());

function dueler(id: string, role: "host" | "challenger", points = 0, acct = id): Player {
  return { accountId: id, acct, role, inviteStatus: "accepted", points, joinedAt: null };
}

/** A game row plus its merit snapshot, as the finale transaction writes it. */
function closedDuel(opts: {
  id: string;
  closedAt: string;
  players: Player[];
  champions: string[];
}): void {
  seedGame(db, { id: opts.id, status: "FINALE", host: opts.players[0]!.accountId });
  for (const p of opts.players) {
    seedPlayer(db, opts.id, p.accountId, { acct: p.acct, invite: "accepted" });
  }
  db.transaction(() => {
    markGameClosed(db, opts.id, new Date(opts.closedAt));
    insertGameResult(db, {
      gameId: opts.id,
      theme: "Theme",
      closedAt: opts.closedAt,
      champions: opts.champions,
    });
    insertParticipants(db, opts.id, opts.players, opts.champions);
  })();
}

describe("merit migration", () => {
  it("adds closed_at and the three merit tables", () => {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((t) => t.name);
    expect(tables).toEqual(expect.arrayContaining(["game_results", "game_participants", "badges"]));

    const cols = (db.prepare("PRAGMA table_info(games)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("closed_at");
  });

  it("is idempotent across repeated migrate calls", () => {
    expect(() => migrate(db)).not.toThrow();
    const v = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number };
    expect(v.v).toBe(17);
  });
});

describe("insertGameResult", () => {
  it("converges on one row when a resumed finale writes again", () => {
    seedGame(db, { id: "g1", status: "FINALE" });
    for (const champions of [["a"], ["b"]]) {
      insertGameResult(db, { gameId: "g1", theme: "T", closedAt: "2026-01-01T00:00:00.000Z", champions });
    }
    expect(db.prepare("SELECT * FROM game_results WHERE game_id = 'g1'").all()).toHaveLength(1);
  });

  it("records a shared crown with its true count", () => {
    seedGame(db, { id: "g1", status: "FINALE" });
    insertGameResult(db, {
      gameId: "g1",
      theme: "T",
      closedAt: "2026-01-01T00:00:00.000Z",
      champions: ["a", "b"],
    });
    const row = db.prepare("SELECT champion_count FROM game_results WHERE game_id = 'g1'").get() as {
      champion_count: number;
    };
    expect(row.champion_count).toBe(2);
  });
});

describe("loadCareer", () => {
  it("is empty for a stranger", () => {
    const career = loadCareer(db, "nobody");
    expect(career.duels).toEqual([]);
    expect(career.opponentCount).toBe(0);
  });

  it("counts duels, wins and hosted from the snapshot", () => {
    closedDuel({
      id: "g1",
      closedAt: "2026-01-01T00:00:00.000Z",
      players: [dueler("a", "host", 5), dueler("b", "challenger", 2)],
      champions: ["a"],
    });
    const career = loadCareer(db, "a");
    expect(career.duels).toHaveLength(1);
    expect(career.hostedCount).toBe(1);
    expect(career.opponentCount).toBe(1);
  });

  it("records only duels that reached game_results", () => {
    // An open duel has a `players` row but no results row.
    seedGame(db, { id: "open", status: "ROUND" });
    seedPlayer(db, "open", "a", { invite: "accepted" });
    expect(loadCareer(db, "a").duels).toEqual([]);
  });

  it("collects the distinct remote instances an account has met", () => {
    closedDuel({
      id: "g1",
      closedAt: "2026-01-01T00:00:00.000Z",
      players: [dueler("a", "host", 5), dueler("b", "challenger", 0, "bob@B.Social")],
      champions: ["a"],
    });
    closedDuel({
      id: "g2",
      closedAt: "2026-01-02T00:00:00.000Z",
      players: [dueler("a", "host", 5), dueler("c", "challenger", 0, "carol@c.social")],
      champions: ["a"],
    });
    expect([...loadCareer(db, "a").remoteInstances].sort()).toEqual(["b.social", "c.social"]);
  });

  it("does not count a local opponent as a remote instance", () => {
    closedDuel({
      id: "g1",
      closedAt: "2026-01-01T00:00:00.000Z",
      players: [dueler("a", "host", 5, "alice"), dueler("b", "challenger", 0, "bob")],
      champions: ["a"],
    });
    expect(loadCareer(db, "a").remoteInstances.size).toBe(0);
  });

  it("does not count an account as its own opponent", () => {
    closedDuel({
      id: "g1",
      closedAt: "2026-01-01T00:00:00.000Z",
      players: [dueler("a", "host", 5)],
      champions: ["a"],
    });
    expect(loadCareer(db, "a").opponentCount).toBe(0);
  });

  it("detects a completed playlist only at the duel's full length", () => {
    seedGame(db, { id: "g1", status: "FINALE", length: 8 });
    seedPlayer(db, "g1", "a", { invite: "accepted" });
    for (let i = 1; i <= 8; i++) {
      db.prepare(
        "INSERT INTO tunes (game_id, account_id, position, video_id, title, canonical_url) VALUES (?,?,?,?,?,?)",
      ).run("g1", "a", i, `v${i}`, `t${i}`, `https://youtu.be/v${i}`);
    }
    db.transaction(() => {
      markGameClosed(db, "g1", new Date("2026-01-01T00:00:00.000Z"));
      insertGameResult(db, { gameId: "g1", theme: "T", closedAt: "2026-01-01T00:00:00.000Z", champions: ["a"] });
      insertParticipants(db, "g1", [dueler("a", "host", 3)], ["a"]);
    })();
    expect(loadCareer(db, "a").completedFullPlaylist).toBe(true);
  });
});

describe("awardNewBadges", () => {
  it("awards debut, first_blood and conductor on a first win", () => {
    closedDuel({
      id: "g1",
      closedAt: "2026-01-01T00:00:00.000Z",
      players: [dueler("a", "host", 5), dueler("b", "challenger", 1)],
      champions: ["a"],
    });
    const fresh = awardNewBadges(db, "a", "g1", new Date("2026-01-01T00:00:00.000Z"));
    expect(fresh).toEqual(expect.arrayContaining(["debut", "first_blood", "conductor"]));
  });

  it("awards nothing on a second call — the ledger is the authority", () => {
    closedDuel({
      id: "g1",
      closedAt: "2026-01-01T00:00:00.000Z",
      players: [dueler("a", "host", 5), dueler("b", "challenger", 1)],
      champions: ["a"],
    });
    const at = new Date("2026-01-01T00:00:00.000Z");
    expect(awardNewBadges(db, "a", "g1", at).length).toBeGreaterThan(0);
    expect(awardNewBadges(db, "a", "g1", at)).toEqual([]);
  });

  it("awards a participation tier only on the duel that crosses it", () => {
    // Award after each duel, the way a real finale does. Seeding all five up
    // front would make one call grant every tier at once.
    for (let i = 0; i < 5; i++) {
      closedDuel({
        id: `g${i}`,
        closedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
        players: [dueler("a", "host", 5, "alice"), dueler(`o${i}`, "challenger", 0, `o${i}@x.social`)],
        champions: ["a"],
      });
      const fresh = awardNewBadges(db, "a", `g${i}`, new Date(`2026-01-0${i + 1}T00:00:00.000Z`));
      if (i < 4) expect(fresh).not.toContain("plays_5");
      else expect(fresh).toContain("plays_5");
    }
  });

  it("awards a streak badge on the crossing duel and keeps it after a later loss", () => {
    for (let i = 0; i < 3; i++) {
      closedDuel({
        id: `g${i}`,
        closedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
        players: [dueler("a", "host", 5), dueler("b", "challenger", 1)],
        champions: ["a"],
      });
      const fresh = awardNewBadges(db, "a", `g${i}`, new Date(`2026-01-0${i + 1}T00:00:00.000Z`));
      if (i === 2) expect(fresh).toContain("hat_trick");
    }

    closedDuel({
      id: "loss",
      closedAt: "2026-02-01T00:00:00.000Z",
      players: [dueler("a", "host", 0), dueler("b", "challenger", 9)],
      champions: ["b"],
    });

    // The loss neither re-awards nor retracts the high-water mark.
    expect(awardNewBadges(db, "a", "loss", new Date())).not.toContain("hat_trick");
    const held = db.prepare("SELECT badge FROM badges WHERE account_id = 'a' AND badge = 'hat_trick'").all();
    expect(held).toHaveLength(1);
  });
});

describe("loadBoard", () => {
  beforeEach(() => {
    closedDuel({
      id: "g1",
      closedAt: "2026-01-01T00:00:00.000Z",
      players: [dueler("a", "host", 9, "alice"), dueler("b", "challenger", 4, "bob")],
      champions: ["a"],
    });
    closedDuel({
      id: "g2",
      closedAt: "2026-01-02T00:00:00.000Z",
      players: [dueler("a", "host", 9, "alice"), dueler("b", "challenger", 4, "bob")],
      champions: ["a"],
    });
  });

  it("ranks wins across every recorded duel", () => {
    const board = loadBoard(db, "wins");
    expect(board[0]).toMatchObject({ accountId: "a", wins: 2, duels: 2 });
    expect(board[1]).toMatchObject({ accountId: "b", wins: 0, duels: 2 });
  });

  it("excludes duels closed before the window", () => {
    const board = loadBoard(db, "wins", { since: "2026-01-02T00:00:00.000Z" });
    expect(board[0]).toMatchObject({ accountId: "a", wins: 1 });
  });

  it("applies the participation floor to duels played, not to wins", () => {
    // Wins can never exceed duels, so the floor cannot be shown by out-winning
    // a qualified player. It is shown by who survives: "c" clears the floor on
    // duels played, "a" and "b" do not, even though "a" has more wins.
    for (let i = 0; i < 3; i++) {
      closedDuel({
        id: `c${i}`,
        closedAt: `2026-01-1${i}T00:00:00.000Z`,
        players: [dueler("c", "host", 5, "cara"), dueler(`x${i}`, "challenger", 0, `x${i}@y.social`)],
        champions: ["c"],
      });
    }

    // Unfiltered: c leads on 3 wins, a has 2, and the three one-duel losers
    // trail with none, ordered among themselves by account id.
    expect(loadBoard(db, "wins").map((e) => e.accountId)).toEqual(["c", "a", "b", "x0", "x1", "x2"]);

    // The floor is on duels: only "c" has 3, so the two-win players drop out
    // even though "a" beat "c" on the ranked metric.
    expect(loadBoard(db, "wins", { minDuels: 3 }).map((e) => e.accountId)).toEqual(["c"]);
  });

  it("reports a 1-based position, and null when unranked", () => {
    expect(boardPosition(db, "a", "wins")).toBe(1);
    expect(boardPosition(db, "b", "wins")).toBe(2);
    expect(boardPosition(db, "nobody", "wins")).toBeNull();
  });

  it("summarises period activity for the anti-void gate", () => {
    expect(boardActivity(db, "2026-01-01T00:00:00.000Z")).toEqual({ closedDuels: 2, distinctPlayers: 2 });
  });
});

describe("meritAcct", () => {
  it("is null for a stranger", () => {
    expect(meritAcct(db, "nobody")).toBeNull();
  });

  it("returns the recorded handle", () => {
    closedDuel({
      id: "g1",
      closedAt: "2026-01-01T00:00:00.000Z",
      players: [dueler("a", "host", 5, "alice@remote.social")],
      champions: ["a"],
    });
    expect(meritAcct(db, "a")).toBe("alice@remote.social");
  });
});

describe("latestClosedGame", () => {
  it("is null before any duel closes", () => {
    expect(latestClosedGame(db)).toBeNull();
  });

  it("returns the most recent closed duel with its thread", () => {
    for (const id of ["g1", "g2"]) {
      seedGame(db, { id, status: "FINALE" });
      db.prepare("UPDATE games SET thread_root_id = ? WHERE id = ?").run(`root-${id}`, id);
    }
    db.transaction(() => {
      insertGameResult(db, { gameId: "g1", theme: "T", closedAt: "2026-01-01T00:00:00.000Z", champions: [] });
      insertGameResult(db, { gameId: "g2", theme: "T", closedAt: "2026-01-05T00:00:00.000Z", champions: [] });
    })();
    expect(latestClosedGame(db)).toEqual({ gameId: "g2", threadRootId: "root-g2" });
  });
});

describe("closed-game bookkeeping", () => {
  it("keeps games.closed_at and game_results.closed_at in agreement", () => {
    closedDuel({
      id: "g1",
      closedAt: "2026-02-02T00:00:00.000Z",
      players: [dueler("a", "host", 5)],
      champions: ["a"],
    });
    const game = db.prepare("SELECT closed_at FROM games WHERE id = 'g1'").get() as { closed_at: string };
    const result = db.prepare("SELECT closed_at FROM game_results WHERE game_id = 'g1'").get() as {
      closed_at: string;
    };
    expect(game.closed_at).toBe(result.closed_at);
  });

  it("leaves a cancelled game without a results row", () => {
    seedGame(db, { id: "c1", status: "COLLECTING" });
    setGameStatus(db, "c1", "COLLECTING", "CANCELLED", new Date("2026-01-01T00:00:00.000Z"));
    const row = db.prepare("SELECT COUNT(*) AS c FROM game_results WHERE game_id = 'c1'").get() as { c: number };
    expect(row.c).toBe(0);
  });
});
