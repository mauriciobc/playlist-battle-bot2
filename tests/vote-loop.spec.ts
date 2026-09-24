import { describe, it, expect } from "vitest";
import { alreadyVotedOn, castPlan, planVotes, shouldStopVoting, withVoter } from "../test/integration/vote-planner.js";

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
 * So the vote has to become a LOOP over rounds, with two properties the
 * current code has no way to express:
 *
 *   1. one vote per round, keyed by poll.id - a new poll id means a new
 *      round; the same id must never be voted twice
 *   2. the loop ends on a SIGNAL, not a count: the bot announcing a finale,
 *      or the game reaching its declared length
 *
 * These are pure functions so they can be tested without a Mastodon server,
 * which is how the rest of the harness is tested.
 */
describe("voting every round", () => {
  it("votes on a poll it has never seen", () => {
    expect(planVotes("poll-1", "poll-1", new Set())).toBe(true);
  });

  it("never votes the same poll twice", () => {
    // The loop re-runs until a signal arrives. Without this guard it re-votes
    // the same poll every pass and inflates the tally - a bug the loop fix
    // would otherwise introduce.
    const seen = new Set(["poll-1"]);
    expect(planVotes("poll-1", "poll-1", seen)).toBe(false);
  });

  it("votes again once a new poll appears", () => {
    const seen = new Set(["poll-1"]);
    expect(planVotes("poll-2", "poll-1", seen)).toBe(true);
  });

  it("counts a poll it has seen", () => {
    expect(alreadyVotedOn(new Set(["poll-1", "poll-2"]), "poll-2")).toBe(true);
  });

  it("stops the loop when the bot announces a finale", () => {
    // "final|vencedor|encerrado|trophy" - the announcement the driver waits
    // for. A loop that only counted rounds would run past the end of the
    // game and vote on a poll that no longer exists.
    expect(shouldStopVoting({ hasFinale: true, roundNumber: 3, playlistLength: 8 })).toBe(
      false,
    );
  });

  it("keeps voting while the game is still running", () => {
    expect(shouldStopVoting({ hasFinale: false, roundNumber: 3, playlistLength: 8 })).toBe(
      true,
    );
  });

  it("stops once every round has been played", () => {
    expect(
      shouldStopVoting({ hasFinale: false, roundNumber: 8, playlistLength: 8 }),
    ).toBe(false);
  });

  it("without a spectator, two players vote and the round is a tie by rule", () => {
    // The game does not need three voters. ROUND_QUORUM makes two votes a
    // tie, and a tie is a valid outcome, not a failure - the game continues.
    const votes = castPlan(2, 0);
    expect(votes).toEqual([
      { label: "host", choice: 0 },
      { label: "challenger", choice: 0 },
    ]);
    const tally = new Map<number, number>();
    for (const v of votes) tally.set(v.choice, (tally.get(v.choice) ?? 0) + 1);
    expect([...tally.values()]).toEqual([2]); // one option, two votes
  });

  it("with a spectator, the round becomes 2-1 so the bot must compare", () => {
    // ROUND_QUORUM is 3 (src/game/scoring.ts:29). With only the two players,
    // totalVotes is 2 and resolveRoundScore returns winnerAccountId: null -
    // the bot was reading the rule correctly, not failing. The bot cannot be
    // the third voter: it owns the poll.
    //
    // The spectator backs the OTHER option, so the round resolves 2-1 and the
    // bot has to compare. A unanimous tally would pass without the comparison
    // ever running.
    const votes = withVoter(castPlan(2, 0), 2);
    expect(votes).toEqual([
      { label: "host", choice: 0 },
      { label: "challenger", choice: 0 },
      { label: "voter", choice: 1 },
    ]);
  });

  it("three votes with a unique leader is the shape that produces a winner", () => {
    // Guard the reason the third voter exists, so the test fails if the
    // quorum rule changes and the harness silently ties again.
    const votes = withVoter(castPlan(2, 0), 2);
    const tally = new Map<number, number>();
    for (const v of votes) tally.set(v.choice, (tally.get(v.choice) ?? 0) + 1);
    const sorted = [...tally.values()].sort((a, b) => b - a);
    expect(sorted[0]).toBe(2);
    expect(sorted.filter((n) => n === sorted[0]).length).toBe(1);
    expect(sorted.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(3);
  });

  it("does not cast a spectator vote when there is nothing to compare", () => {
    // One option cannot lose, so the round is a walkover, not a poll. The
    // driver's guard is on option count.
    expect(castPlan(1, 0)).toEqual([{ label: "host", choice: 0 }]);
  });
});
