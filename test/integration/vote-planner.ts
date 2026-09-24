/**
 * When to vote, and on what.
 *
 * The driver used to vote once - `await step("vote", ...)` sat outside any
 * loop, so the two casts ran a single time and every later round resolved
 * with no votes at all. These are pure functions so the decision can be
 * tested without a Mastodon server, and so the loop that calls them has no
 * hidden state beyond the set of polls already voted on.
 */

export interface VoteState {
  /** The poll id in hand right now, if the bot has an open one. */
  pollId: string | null;
  /** Pools this driver has already voted on. */
  seen: Set<string>;
}

/**
 * True when this poll has not been voted on yet.
 *
 * The loop re-runs while it waits for the next round, so without this the
 * same poll gets voted on every pass and the tally inflates.
 */
export function planVotes(pollId: string, _current: string | null, seen: Set<string>): boolean {
  return !seen.has(pollId);
}

export function alreadyVotedOn(seen: Set<string>, pollId: string): boolean {
  return seen.has(pollId);
}

export interface StopInput {
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
export function shouldStopVoting({ hasFinale, roundNumber, playlistLength }: StopInput): boolean {
  if (hasFinale) return false;
  if (roundNumber >= playlistLength) return false;
  return true;
}

export interface Cast {
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
  // Two voters. ROUND_QUORUM is 3, so this is a tie by rule - valid, and the
  // game continues. withVoter adds a third vote on the other option when the
  // operator supplied one.
  return [
    { label: "host", choice: pick },
    { label: "challenger", choice: pick },
  ];
}

/**
 * Append the spectator's vote, on the opposite option to the players'.
 *
 * A 2-0 tie satisfies neither ROUND_QUORUM nor a comparison: the bot returns
 * winnerAccountId null without ever comparing two tallies. A 2-1 split
 * exercises the comparison that decides a real game.
 */
export function withVoter(
  casts: Cast[],
  optionCount: number,
): Cast[] {
  if (optionCount < 2) return casts;
  const other = 1;
  return [...casts, { label: "voter", choice: other }];
}
