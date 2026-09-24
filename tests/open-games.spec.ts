import { describe, it, expect } from "vitest";
import { isOpen, openGames, TERMINAL_STATUSES } from "../src/game/types.js";
import type { GameStatus } from "../src/game/types.js";
import { NON_TERMINAL_STATUS_SQL } from "../src/db/index.js";

/**
 * My ad-hoc "how many games are open" query listed only
 * CLOSED/FINALIZED/CANCELLED. FINALIZED is not even a GameStatus, and
 * FIZZLED/EXPIRED/FORFEIT were missing - so a FIZZLED game read as open
 * and I reported four dirty games when the real count was lower.
 *
 * src/game/store.ts:150 gates on NON_TERMINAL_STATUS_SQL, which is built
 * from TERMINAL_STATUSES in src/game/types.ts. The harness must use the same
 * definition or its idea of "clean" is fiction.
 */
describe("open-game predicate", () => {
  it("treats every terminal status as closed", () => {
    for (const s of TERMINAL_STATUSES) {
      expect(isOpen(s), `${s} should be terminal`).toBe(false);
    }
  });

  it("treats in-flight statuses as open", () => {
    const live: GameStatus[] = ["CREATED", "INVITED", "COLLECTING", "READY", "ROUND", "FINALE"];
    for (const s of live) {
      expect(isOpen(s), `${s} should be open`).toBe(true);
    }
  });

  it("excludes FIZZLED, the status my query missed", () => {
    expect(isOpen("FIZZLED")).toBe(false);
  });

  it("does not treat FINALIZED as a real status", () => {
    // It was in my hand-written list but is not in GameStatus.
    expect(TERMINAL_STATUSES as readonly string[]).not.toContain("FINALIZED");
  });

  it("filters a mixed list to only the open games", () => {
    const games: Array<{ id: string; status: GameStatus; theme: string }> = [
      { id: "a", status: "FIZZLED", theme: "t" },
      { id: "b", status: "COLLECTING", theme: "t" },
      { id: "c", status: "ROUND", theme: "t" },
      { id: "d", status: "CANCELLED", theme: "t" },
    ];
    expect(openGames(games).map((g) => g.status)).toEqual(["COLLECTING", "ROUND"]);
  });

  it("builds the SQL predicate from the same list", () => {
    for (const s of TERMINAL_STATUSES) {
      expect(NON_TERMINAL_STATUS_SQL).toContain(`'${s}'`);
    }
  });
});
