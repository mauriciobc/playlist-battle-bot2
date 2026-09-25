/**
 * When to vote, and on what.
 *
 * The driver used to vote once - `await step("vote", ...)` sat outside any
 * loop, so the two casts ran a single time and every later round resolved
 * with no votes at all. These are pure functions so the decision can be
 * tested without a Mastodon server, and so the loop that calls them has no
 * hidden state beyond the set of polls already voted on.
 */

interface StopInput {
  /** The bot has announced a finale, champion or verdict. */
  hasFinale: boolean;
  /** Round number currently in play. */
  roundNumber: number;
  /** Tunes in the playlist, which is also the round count. */
  playlistLength: number;
}

/**
 * True while the duel is still running.
 *
 * Stops on either signal: the bot's own announcement, or the declared length
 * being played out. Counting rounds alone would overshoot a game that ended
 * early, and waiting for the announcement alone would hang on a game that
 * simply ran its course.
 */
export function keepVoting({ hasFinale, roundNumber, playlistLength }: StopInput): boolean {
  return !(hasFinale || roundNumber >= playlistLength);
}

interface Cast {
  label: string;
  choice: number;
}

/**
 * Both sides back the same option, so a round with their votes has a winner.
 *
 * The earlier driver put the host on 0 and the challenger on 1 - a guaranteed
 * 1-1 tie, which is why every round resolved as a tie. The comment claimed
 * the opposite of what the code did.
 */
export function castPlan(optionCount: number, pick: number): Cast[] {
  // optionCount < 2 means there is nothing to compare - one option cannot lose,
  // so the round would be a walkover rather than a poll.
  if (optionCount < 2) return [{ label: "host", choice: pick }];
  return [
    { label: "host", choice: pick },
    { label: "challenger", choice: pick },
    // The spectator. ROUND_QUORUM is 3, so the two players alone always tie;
    // the driver supplies the third vote itself since the bot owns the poll.
    { label: "voter", choice: 1 },
  ];
}
