import { m } from "../i18n/index.js";
import { truncate, POST_LIMIT } from "../templates/truncate.js";
import {
  bestWinStreak,
  winCount,
  type BadgeId,
  type BoardEntry,
  type BoardMetric,
} from "../game/merit.js";
import { loadBoard, loadCareer, awardedBadges } from "../db/merit.js";
import type { Db } from "../db/index.js";
import { mention } from "../mastodon/handle.js";

/**
 * The pull path: everything the merit system can be asked for on demand.
 *
 * Both surfaces (a public reply and a DM) render the same text, so the budget
 * rules and the row shapes live here rather than in each caller.
 */

/** Rolling window for the board, in days. */
const BOARD_WINDOW_DAYS = 30;
/** Duels a player needs before they appear on the wins board. */
export const BOARD_MIN_DUELS = 3;
/** Rows rendered on a board. */
const BOARD_ROWS = 5;

/** Days since the window start, rendered for the header. */
function windowLabel(now: Date): string {
  const since = new Date(now.getTime() - BOARD_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return since.toISOString().slice(0, 10);
}

/**
 * A ranked board over the rolling window, or the reason there is none.
 *
 * The participation floor is what keeps a single lucky win off the top, and it
 * is also why a young board can legitimately be empty — an empty board says
 * "play more", which is honest, where a 1-1 record at the top would not be.
 */
export function boardText(db: Db, now: Date, metric: BoardMetric = "wins", instanceDomain?: string): string {
  const since = new Date(now.getTime() - BOARD_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const board = loadBoard(db, metric, { since, minDuels: BOARD_MIN_DUELS });

  if (board.length === 0) {
    const anyDuels = loadBoard(db, metric, { since }).length;
    const lines = [m().boardHeader(windowLabel(now)), anyDuels > 0 ? m().boardFloor() : m().boardEmpty()];
    return lines.join("\n");
  }

  const rows = board.slice(0, BOARD_ROWS).map((e, i) =>
    m().boardRow(i + 1, mention(e.acct, instanceDomain), metric === "wins" ? m().boardWins(e.wins) : m().boardDuels(e.duels)),
  );
  const overflow = board.length - rows.length;
  const body = overflow > 0 ? m().boardListOverflow(overflow) : "";
  return truncate([m().boardHeader(windowLabel(now)), ...rows, body].filter(Boolean).join("\n"), POST_LIMIT);
}

/** Whether the board has anyone to show; false means "play more", not news. */
export function boardHasRows(db: Db, now: Date, metric: BoardMetric = "wins"): boolean {
  const since = new Date(now.getTime() - BOARD_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return loadBoard(db, metric, { since, minDuels: BOARD_MIN_DUELS }).length > 0;
}

/** One player's record: badges held, plus the career line behind them. */
export function playerText(db: Db, accountId: string, acct: string, instanceDomain?: string): string {
  const career = loadCareer(db, accountId);
  const held = [...awardedBadges(db, accountId)] as BadgeId[];
  const header = m().playerHeader(mention(acct, instanceDomain));

  if (held.length === 0) {
    return [header, m().playerNoBadges()].join("\n");
  }

  const stats = m().playerStats(
    winCount(career.duels),
    career.duels.length,
    bestWinStreak(career.duels),
  );
  const lines = [
    header,
    stats,
    ...held.map((b) => m().badgeListLine(m().badgeName(b))),
  ];
  return truncate(lines.join("\n"), POST_LIMIT);
}

/** The board, plus where the asker stands on it. */
export function rankingTextFor(db: Db, accountId: string, acct: string, now: Date, instanceDomain?: string): string {
  const board = boardText(db, now, "wins", instanceDomain);
  const since = new Date(now.getTime() - BOARD_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const placing = loadBoard(db, "wins", { since, minDuels: BOARD_MIN_DUELS });
  const index = placing.findIndex((e: BoardEntry) => e.accountId === accountId);
  const standing = index === -1 ? m().boardUnranked() : m().boardYourRank(index + 1, placing.length);
  return truncate([board, standing].join("\n"), POST_LIMIT);
}
