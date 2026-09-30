/**
 * Merit system: achievements, win streaks, and leaderboard ranking.
 * Pure — no I/O, no Mastodon, no DB. Mirrors `scoring.ts` / `engine.ts`.
 *
 * Career totals are always derived from the `game_participants` / `badges`
 * snapshots the finale writes, never accumulated here, so a badge can never
 * drift from the games that earned it.
 */

/** A closed duel, as recorded by the finale snapshot. */
export type DuelRecord = {
  gameId: string;
  closedAt: string;
  /** True when this account was actually crowned — a shared crown counts. */
  wasChampion: boolean;
};

/** Everything the badge rules need to know about one account. */
export type CareerInput = {
  accountId: string;
  /** Closed duels this account played, any order. */
  duels: readonly DuelRecord[];
  /** Whether it hosted any of them. */
  hostedCount: number;
  /** Remote instances this account met a player on, lowercase. */
  remoteInstances: ReadonlySet<string>;
  /** Distinct opponents across those duels. */
  opponentCount: number;
  /** Whether a full-length playlist was ever completed. */
  completedFullPlaylist: boolean;
  /** Whether a duel was played through to its final round. */
  playedToFinalRound: boolean;
};

/** Badge ids. Stable strings: they are persisted in `badges.badge`. */
export const BADGE_IDS = [
  "debut",
  "plays_5",
  "plays_25",
  "completionist",
  "marathon",
  "first_blood",
  "hat_trick",
  "on_a_run",
  "unstoppable",
  "first_contact",
  "wanderer",
  "durable",
  "conductor",
  "promoter",
] as const;

export type BadgeId = (typeof BADGE_IDS)[number];

/** One player's badges earned in a single duel, for the finale announcement. */
export type AwardedBadges = {
  accountId: string;
  acct: string;
  badges: BadgeId[];
};

/** Consecutive wins each streak badge requires. */
const STREAK_THRESHOLDS: ReadonlyArray<readonly [BadgeId, number]> = [
  ["hat_trick", 3],
  ["on_a_run", 5],
  ["unstoppable", 10],
];

/** Duels played for each participation tier. */
const PLAY_THRESHOLDS: ReadonlyArray<readonly [BadgeId, number]> = [
  ["plays_5", 5],
  ["plays_25", 25],
];

/** Hosts a duel counts toward `promoter`. */
const HOST_THRESHOLD = 10;
/** Distinct instances for `wanderer`, opponents for `durable`. */
const WANDERER_INSTANCES = 3;
const DURABLE_OPPONENTS = 10;

/**
 * The domain a handle was met on; null for a local account.
 *
 * This is the domain at invite time. It does not follow an account that later
 * migrates instances, so `first_contact` records where you met someone rather
 * than where they live now — acceptable for a merit badge, but the semantics
 * are "where we met", not "where they are".
 */
export function instanceOf(acct: string): string | null {
  const at = acct.lastIndexOf("@");
  return at > 0 ? acct.slice(at + 1).toLowerCase() : null;
}

/** Total wins across every duel played. A shared crown counts as a win. */
export function winCount(duels: readonly DuelRecord[]): number {
  return duels.reduce((sum, d) => sum + (d.wasChampion ? 1 : 0), 0);
}

/**
 * Longest run of consecutive wins, newest duel first.
 *
 * Ordering is by `closedAt` descending, with the game id breaking ties so two
 * duels closed in the same tick still order deterministically. A duel the
 * account did not play is not in the input, so it cannot break the run — that
 * is deliberate: a streak is a high-water mark, never something a break in play
 * takes back. Streak badges are therefore awarded once and kept.
 */
export function bestWinStreak(duels: readonly DuelRecord[]): number {
  const ordered = [...duels].sort(
    (a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt) || b.gameId.localeCompare(a.gameId),
  );
  let best = 0;
  let run = 0;
  for (const duel of ordered) {
    run = duel.wasChampion ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/**
 * Every badge this career qualifies for, in a stable order.
 *
 * The caller diffs against `badges` to learn what is new. Predicates are pure
 * and idempotent, so re-running a recovered finale awards nothing twice.
 */
export function earnedBadges(career: CareerInput): BadgeId[] {
  const earned: BadgeId[] = [];
  const played = career.duels.length;
  const wins = winCount(career.duels);
  const streak = bestWinStreak(career.duels);

  if (played >= 1) earned.push("debut");
  for (const [badge, at] of PLAY_THRESHOLDS) {
    if (played >= at) earned.push(badge);
  }
  if (career.completedFullPlaylist) earned.push("completionist");
  if (career.playedToFinalRound) earned.push("marathon");
  if (wins >= 1) earned.push("first_blood");
  for (const [badge, at] of STREAK_THRESHOLDS) {
    if (streak >= at) earned.push(badge);
  }
  if (career.remoteInstances.size >= 1) earned.push("first_contact");
  if (career.remoteInstances.size >= WANDERER_INSTANCES) earned.push("wanderer");
  if (career.opponentCount >= DURABLE_OPPONENTS) earned.push("durable");
  // Hosting implies having played: game_participants only records duelers, so
  // a hosted duel is one the account was in. Gating on `played` keeps the rule
  // honest for any caller rather than trusting that invariant upstream.
  if (played >= 1 && career.hostedCount >= 1) earned.push("conductor");
  if (played >= 1 && career.hostedCount >= HOST_THRESHOLD) earned.push("promoter");

  return earned;
}

/** One row of a leaderboard board. */
export type BoardEntry = {
  accountId: string;
  acct: string;
  wins: number;
  duels: number;
};

export type BoardMetric = "wins" | "duels";

/**
 * A ranked board, best first.
 *
 * `minDuels` is a participation floor applied to `duels`, not to the ranked
 * score: a 1-1 record must not outrank a 9-2, and gating on the score itself
 * would let a single win qualify where it should not. Account id breaks ties
 * so equal scores order stably across runs.
 */
export function rankBoard(
  entries: readonly BoardEntry[],
  metric: BoardMetric,
  minDuels = 0,
): BoardEntry[] {
  return entries
    .filter((e) => e.duels >= minDuels)
    .sort((a, b) => b[metric] - a[metric] || a.accountId.localeCompare(b.accountId));
}

/**
 * Whether a period is worth a leaderboard post.
 *
 * A board over an empty week is worse than silence: it shows nobody anything
 * and reads as a dead bot. On a personal account that is a bad trade.
 */
export function shouldPublishBoard(input: { closedDuels: number; distinctPlayers: number }): boolean {
  return input.closedDuels >= 2 && input.distinctPlayers >= 3;
}
