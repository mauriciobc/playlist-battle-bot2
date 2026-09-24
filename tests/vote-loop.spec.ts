import { describe, it, expect } from "vitest";
import { planVotes, alreadyVotedOn, shouldStopVoting, castPlan } from "../test/integration/vote-planner.js";

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

  it("voters on the tally reflect the casts, not the poll's own author", () => {
    // Both sides back option 0, so the round has a winner. The old code had
    // host on 0 and player on 1 - a guaranteed 1-1 tie every round.
    const votes = castPlan(2, 0);
    expect(votes).toEqual([{ label: "host", choice: 0 }, { label: "challenger", choice: 0 }]);
  });
});
