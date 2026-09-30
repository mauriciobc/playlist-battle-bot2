import { describe, expect, it } from "vitest";
import { emitFinale } from "../src/scheduler/roundState.js";
import { awardsForGame, loadBoard, loadCareer } from "../src/db/merit.js";
import {
  count,
  gameRow,
  seedDuel,
  seedGame,
  seedPlayer,
  seedPlaylist,
  seedResolvedRounds,
  useHarness,
  type SeedGame,
} from "./support.js";

/**
 * The finale is the only place merit is written, so these cover the wiring:
 * that a closed duel is recorded once, that the achievement reply lands in the
 * thread, and that a resumed finale converges instead of double-posting.
 */
describe("finale records merit", () => {
  const h = useHarness();

  /** A FINALE duel with two resolved rounds and explicit final points. */
  function seedFinale(o: SeedGame & { points?: [number, number] } = {}): string {
    const [hostPoints, alicePoints] = o.points ?? [5, 2];
    const gameId = seedGame(h.db, { status: "FINALE", theme: "Road Trip", currentRound: 8, ...o });
    seedPlayer(h.db, gameId, "id-host", { acct: "host", invite: "accepted", points: hostPoints });
    seedPlayer(h.db, gameId, "id-alice", { acct: "alice", invite: "accepted", points: alicePoints });
    for (const id of ["id-host", "id-alice"]) seedPlaylist(h.db, gameId, id);
    seedResolvedRounds(h.db, gameId, ["id-host", "id-alice"]);
    return gameId;
  }

  const resultsFor = (gameId: string) =>
    h.db.prepare("SELECT * FROM game_results WHERE game_id = ?").all(gameId) as { theme: string }[];
  const participantsFor = (gameId: string) =>
    h.db
      .prepare("SELECT * FROM game_participants WHERE game_id = ? ORDER BY account_id")
      .all(gameId) as { account_id: string; was_champion: number }[];

  it("snapshots the duel and closes the game", async () => {
    const gameId = seedFinale();

    await emitFinale(h.deps, gameId);

    expect(resultsFor(gameId)).toHaveLength(1);
    expect(resultsFor(gameId)[0]!.theme).toBe("Road Trip");
    expect(gameRow(h.db, gameId).status).toBe("CLOSED");
    expect(gameRow(h.db, gameId).closed_at).toBeTruthy();
  });

  it("records exactly one crowned account when one player leads", async () => {
    const gameId = seedFinale({ points: [5, 2] });
    await emitFinale(h.deps, gameId);

    const crowned = participantsFor(gameId).filter((p) => p.was_champion === 1);
    expect(crowned).toHaveLength(1);
  });

  it("crowns both on a shared championship, as scoring.champions does", async () => {
    // The all-zero case: every round tied, so the pot zeroes and nobody leads.
    // Re-deriving a champion from points alone would have crowned everyone;
    // reading the recorded outcome keeps this an honest shared crown.
    const gameId = seedFinale({ points: [0, 0] });

    await emitFinale(h.deps, gameId);

    const crowned = participantsFor(gameId).filter((p) => p.was_champion === 1);
    expect(crowned).toHaveLength(2);
    expect(resultsFor(gameId)).toHaveLength(1);
  });

  it("records only the accounts that actually played", async () => {
    // A third accepted player who never played a round is not a dueler and
    // must not appear — that exclusion is what the crown depends on.
    const gameId = seedFinale();
    seedPlayer(h.db, gameId, "id-ghost", { acct: "ghost", invite: "accepted" });

    await emitFinale(h.deps, gameId);

    expect(participantsFor(gameId).map((p) => p.account_id)).toEqual(["id-alice", "id-host"]);
  });

  it("posts the achievement reply into the thread", async () => {
    const gameId = seedFinale();

    await emitFinale(h.deps, gameId);

    const reply = h.posts.find((p) => /Achievements unlocked/.test(String(p.body.status)));
    expect(reply).toBeDefined();
    expect(reply!.body).toMatchObject({ in_reply_to_id: "s-1" });
  });

  it("converges on a second emission without duplicating merit or posts", async () => {
    const gameId = seedFinale();

    await emitFinale(h.deps, gameId);
    const firstPostCount = h.posts.length;
    const firstAwards = count(h.db, "badges");

    // A closed game is never revisited, so a replay must not add rows or posts.
    await emitFinale(h.deps, gameId);

    expect(count(h.db, "badges")).toBe(firstAwards);
    expect(resultsFor(gameId)).toHaveLength(1);
    expect(participantsFor(gameId)).toHaveLength(2);
    expect(h.posts.length).toBe(firstPostCount);
  });

  it("leaves no merit rows for a game that expired", async () => {
    // A non-CLOSED terminal state never reaches the finale, so it cannot
    // contribute to anyone's career.
    seedGame(h.db, { id: "expired", status: "EXPIRED" });
    seedPlayer(h.db, "expired", "id-lonely", { acct: "lonely" });

    expect(count(h.db, "game_results")).toBe(0);
    expect(loadCareer(h.db, "id-lonely").duels).toEqual([]);
    expect(loadBoard(h.db, "wins")).toEqual([]);
  });
});

describe("merit through a real duel", () => {
  const h = useHarness();

  /** A complete duel at the finale, won outright by host1. */
  function seedDecidedDuel(): string {
    const gameId = seedDuel(h.db, { status: "FINALE", theme: "Road Trip", length: 8, points: [9, 2] });
    seedResolvedRounds(h.db, gameId, Array.from({ length: 8 }, () => "host1"));
    return gameId;
  }

  it("gives the winner skill credit and the loser participation credit", async () => {
    const gameId = seedDecidedDuel();

    await emitFinale(h.deps, gameId);

    const awards = new Map(awardsForGame(h.db, gameId).map((a) => [a.accountId, a.badges]));
    expect([...awards.keys()].sort()).toEqual(["alice", "host1"]);
    expect(awards.get("host1")).toEqual(expect.arrayContaining(["debut", "first_blood", "conductor"]));
    // The loser still earns credit for showing up. This is the rule that keeps
    // a fourth-place player in the game.
    expect(awards.get("alice")).toContain("debut");
    expect(awards.get("alice")).not.toContain("first_blood");
  });

  it("ranks the winner above the loser", async () => {
    await emitFinale(h.deps, seedDecidedDuel());

    const board = loadBoard(h.db, "wins");
    expect(board[0]!.accountId).toBe("host1");
    expect(board[1]!.accountId).toBe("alice");
  });
});
