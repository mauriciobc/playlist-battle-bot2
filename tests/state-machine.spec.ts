import { describe, expect, it } from "vitest";
import {
  canTransition,
  sourceStatuses,
  transition,
  transitionTargets,
  TransitionError,
} from "../src/game/stateMachine.js";

describe("state machine (PRD §5)", () => {
  it("CREATED → INVITED on INVITE_SENT", () => {
    expect(transition("CREATED", "INVITE_SENT")).toBe("INVITED");
  });

  it("INVITED → COLLECTING on FIRST_ACCEPT", () => {
    expect(transition("INVITED", "FIRST_ACCEPT")).toBe("COLLECTING");
  });

  it("INVITED → EXPIRED when no challenger accepts", () => {
    expect(transition("INVITED", "ACCEPT_WINDOW_EXPIRED_NONE")).toBe("EXPIRED");
  });

  it("COLLECTING → READY when all playlists ready", () => {
    expect(transition("COLLECTING", "ALL_PLAYLISTS_READY")).toBe("READY");
  });

  it("SUBMISSION_WINDOW_EXPIRED is ambiguous (READY or FIZZLED) — engine chooses", () => {
    expect(transitionTargets("COLLECTING", "SUBMISSION_WINDOW_EXPIRED").sort()).toEqual([
      "FIZZLED",
      "READY",
    ]);
    expect(() => transition("COLLECTING", "SUBMISSION_WINDOW_EXPIRED")).toThrow(TransitionError);
    expect(transition("COLLECTING", "SUBMISSION_WINDOW_EXPIRED", "READY")).toBe("READY");
    expect(transition("COLLECTING", "SUBMISSION_WINDOW_EXPIRED", "FIZZLED")).toBe("FIZZLED");
  });

  it("COLLECTING → FINALE on DEFAULT_WIN (one complete playlist)", () => {
    expect(transition("COLLECTING", "DEFAULT_WIN")).toBe("FINALE");
  });

  it("READY → ROUND on START_ROUND", () => {
    expect(transition("READY", "START_ROUND")).toBe("ROUND");
  });

  it("ROUND → ROUND on round resolution (next round)", () => {
    expect(transition("ROUND", "ROUND_RESOLVED", "ROUND")).toBe("ROUND");
  });

  it("ROUND → FINALE on final round resolution (engine chooses target)", () => {
    expect(transitionTargets("ROUND", "ROUND_RESOLVED").sort()).toEqual(["FINALE", "ROUND"]);
    expect(transition("ROUND", "ROUND_RESOLVED", "FINALE")).toBe("FINALE");
  });

  it("AUTO_TIE and WALKOVER keep game in ROUND or move to FINALE", () => {
    expect(transitionTargets("ROUND", "AUTO_TIE").sort()).toEqual(["FINALE", "ROUND"]);
    expect(transitionTargets("ROUND", "WALKOVER").sort()).toEqual(["FINALE", "ROUND"]);
  });

  it("FINALE → CLOSED on FINALE_POSTED", () => {
    expect(transition("FINALE", "FINALE_POSTED")).toBe("CLOSED");
  });

  it("PLAYER_DELETED → FORFEIT from active states (v1.1 1.5 includes READY and FINALE)", () => {
    for (const s of ["INVITED", "COLLECTING", "READY", "ROUND", "FINALE"] as const) {
      expect(transition(s, "PLAYER_DELETED")).toBe("FORFEIT");
    }
  });

  it("CANCEL from pre-finale active states → CANCELLED", () => {
    for (const s of ["CREATED", "INVITED", "COLLECTING", "ROUND"] as const) {
      expect(transition(s, "CANCEL")).toBe("CANCELLED");
    }
  });

  it("sourceStatuses lists exactly the statuses an event can fire from", () => {
    expect(sourceStatuses("CANCEL").sort()).toEqual(["COLLECTING", "CREATED", "INVITED", "ROUND"]);
    expect(sourceStatuses("PLAYER_DELETED").sort()).toEqual([
      "COLLECTING",
      "FINALE",
      "INVITED",
      "READY",
      "ROUND",
    ]);
    expect(sourceStatuses("INVITE_SENT")).toEqual(["CREATED"]);
  });

  it("rejects invalid transitions", () => {
    expect(canTransition("CLOSED", "INVITE_SENT")).toBe(false);
    expect(() => transition("CLOSED", "INVITE_SENT")).toThrow(TransitionError);
    expect(() => transition("CREATED", "FIRST_ACCEPT")).toThrow(TransitionError);
    expect(() => transition("EXPIRED", "START_ROUND")).toThrow(TransitionError);
  });

  it("rejects invalid choice among ambiguous targets", () => {
    expect(() => transition("ROUND", "ROUND_RESOLVED", "EXPIRED")).toThrow(TransitionError);
  });
});
