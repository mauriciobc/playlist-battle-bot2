import type { GameStatus } from "./types.js";

/**
 * Pure state machine for the game lifecycle (PRD §5).
 * Invalid transitions throw TransitionError — callers must guard via canTransition.
 */

export type GameEvent =
  | "INVITE_SENT" // creation post made, DMs dispatched → INVITED
  | "FIRST_ACCEPT" // ≥1 challenger accepted → COLLECTING
  | "ACCEPT_WINDOW_EXPIRED_NONE" // → EXPIRED
  | "ALL_PLAYLISTS_READY" // → READY (then ROUND starts)
  | "SUBMISSION_WINDOW_EXPIRED" // resolved outcomes → READY | FIZZLED (engine picks)
  | "START_ROUND" // READY → ROUND
  | "ROUND_RESOLVED" // ROUND k → ROUND k+1 | FINALE
  | "WALKOVER" // single remaining player wins round
  | "AUTO_TIE" // duplicate videos → tie, pot++
  | "GAME_COMPLETE" // last round done → FINALE
  | "FINALE_POSTED" // → CLOSED
  | "DEFAULT_WIN" // one complete playlist at deadline → FINALE path
  | "FIZZLE" // zero complete playlists
  | "PLAYER_DELETED" // → FORFEIT
  | "CANCEL"; // → CANCELLED

type Transition = {
  from: GameStatus;
  event: GameEvent;
  to: GameStatus;
};

const TRANSITIONS: Transition[] = [
  { from: "CREATED", event: "INVITE_SENT", to: "INVITED" },
  { from: "INVITED", event: "FIRST_ACCEPT", to: "COLLECTING" },
  { from: "INVITED", event: "ACCEPT_WINDOW_EXPIRED_NONE", to: "EXPIRED" },
  { from: "COLLECTING", event: "ALL_PLAYLISTS_READY", to: "READY" },
  { from: "COLLECTING", event: "SUBMISSION_WINDOW_EXPIRED", to: "READY" },
  { from: "COLLECTING", event: "SUBMISSION_WINDOW_EXPIRED", to: "FIZZLED" },
  { from: "COLLECTING", event: "FIZZLE", to: "FIZZLED" },
  { from: "COLLECTING", event: "DEFAULT_WIN", to: "FINALE" },
  { from: "READY", event: "START_ROUND", to: "ROUND" },
  { from: "ROUND", event: "ROUND_RESOLVED", to: "ROUND" },
  { from: "ROUND", event: "ROUND_RESOLVED", to: "FINALE" },
  { from: "ROUND", event: "WALKOVER", to: "ROUND" },
  { from: "ROUND", event: "WALKOVER", to: "FINALE" },
  { from: "ROUND", event: "AUTO_TIE", to: "ROUND" },
  { from: "ROUND", event: "AUTO_TIE", to: "FINALE" },
  { from: "FINALE", event: "FINALE_POSTED", to: "CLOSED" },
  { from: "INVITED", event: "PLAYER_DELETED", to: "FORFEIT" },
  { from: "COLLECTING", event: "PLAYER_DELETED", to: "FORFEIT" },
  { from: "READY", event: "PLAYER_DELETED", to: "FORFEIT" },
  { from: "ROUND", event: "PLAYER_DELETED", to: "FORFEIT" },
  { from: "FINALE", event: "PLAYER_DELETED", to: "FORFEIT" },
  { from: "CREATED", event: "CANCEL", to: "CANCELLED" },
  { from: "INVITED", event: "CANCEL", to: "CANCELLED" },
  { from: "COLLECTING", event: "CANCEL", to: "CANCELLED" },
  { from: "ROUND", event: "CANCEL", to: "CANCELLED" },
];

export class TransitionError extends Error {
  override readonly name = "TransitionError";
}

export function canTransition(from: GameStatus, event: GameEvent): boolean {
  return TRANSITIONS.some((t) => t.from === from && t.event === event);
}

/**
 * Statuses from which `event` is legal. Callers that need to *query* for
 * candidates (e.g. "the host's open game I may cancel") derive their status
 * list from here instead of restating the transition table in SQL.
 */
export function sourceStatuses(event: GameEvent): GameStatus[] {
  const out: GameStatus[] = [];
  for (const t of TRANSITIONS) {
    if (t.event === event && !out.includes(t.from)) out.push(t.from);
  }
  return out;
}

/** Allowed target states for (from, event) — 0 = invalid, many = engine chooses. */
export function transitionTargets(from: GameStatus, event: GameEvent): GameStatus[] {
  return TRANSITIONS.filter((t) => t.from === from && t.event === event).map((t) => t.to);
}

export function transition(from: GameStatus, event: GameEvent, choose?: GameStatus): GameStatus {
  const targets = transitionTargets(from, event);
  if (targets.length === 0) {
    throw new TransitionError(`Invalid transition: ${from} --${event}--> ?`);
  }
  if (targets.length === 1) return targets[0]!;
  if (choose === undefined) {
    throw new TransitionError(
      `Ambiguous transition: ${from} --${event}--> [${targets.join(", ")}]; choose target`,
    );
  }
  if (!targets.includes(choose)) {
    throw new TransitionError(
      `Invalid target ${choose} for ${from} --${event}--> [${targets.join(", ")}]`,
    );
  }
  return choose;
}
