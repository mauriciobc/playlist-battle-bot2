import { describe, it, expect } from "vitest";
import { keepVoting, castPlan } from "../test/integration/vote-planner.js";

/**
 * The driver voted once, in the first round, and then left the rest of the
 * duel to the bot. driver.ts had `await step("vote", ...)` OUTSIDE any loop,
 * so the two casts ran a single time and rounds 2..8 resolved with no votes
 * at all:
 *
 *   #1  votos=2   host=1002? no - 1002:0  1003:2
 *   #2  votos=0
 *   #3  votos=0
 *   #4  votos=0
 *
 * The bot read every tally correctly and called each of those a tie, which is
 * the right behaviour for a round nobody voted in.
 *
 * So the vote is a LOOP over rounds that ends on a SIGNAL, not a count: the
 * bot announcing a finale, or the game reaching its declared length. Each
 * round needs enough ballots to reach quorum with a unique leader.
 */
describe("voting every round", () => {
  it("stops the loop when the bot announces a finale", () => {
    // "final|vencedor|encerrado|trophy" - the announcement the driver waits
    // for. A loop that only counted rounds would run past the end of the
    // game and vote on a poll that no longer exists.
    expect(keepVoting({ hasFinale: true, roundNumber: 3, playlistLength: 8 })).toBe(false);
  });

  it("keeps voting while the game is still running", () => {
    expect(keepVoting({ hasFinale: false, roundNumber: 3, playlistLength: 8 })).toBe(true);
  });

  it("stops once every round has been played", () => {
    expect(keepVoting({ hasFinale: false, roundNumber: 8, playlistLength: 8 })).toBe(false);
  });

  it("casts three votes: two players on option 0, a spectator on option 1", () => {
    // ROUND_QUORUM is 3 (src/game/scoring.ts:29). With only the two players,
    // totalVotes is 2 and resolveRoundScore returns winnerAccountId: null -
    // the bot was reading the rule correctly, not failing. The bot cannot be
    // the third voter: it owns the poll.
    //
    // The spectator backs the OTHER option, so the round resolves 2-1 and the
    // bot has to compare. A unanimous tally would pass without the comparison
    // ever running.
    expect(castPlan(2, 0)).toEqual([
      { label: "host", choice: 0 },
      { label: "challenger", choice: 0 },
      { label: "voter", choice: 1 },
    ]);
  });

  it("does not cast a spectator vote when there is nothing to compare", () => {
    // One option cannot lose, so the round is a walkover, not a poll. The
    // driver's guard is on option count.
    expect(castPlan(1, 0)).toEqual([{ label: "host", choice: 0 }]);
  });
});
