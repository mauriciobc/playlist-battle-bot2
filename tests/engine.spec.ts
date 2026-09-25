import { describe, expect, it } from "vitest";
import {
  createGameInput,
  MAX_THEME_LENGTH,
  validateCreate,
  acceptInvite,
  declineInvite,
  submitTune,
  finalizeCollection,
  startRound,
  resolveRound,
  type CreateGameInput,
} from "../src/game/engine.js";
import type { Player, Tune } from "../src/game/types.js";

const NOW = new Date("2026-09-21T12:00:00Z");
const CFG = { pollDurationSec: 86400, acceptanceWindowSec: 86400, id: "g" };

function validCreate(overrides: Partial<CreateGameInput> = {}): CreateGameInput {
  return {
    host: { accountId: "host1", acct: "host" },
    theme: "80s Synth",
    playlistLength: 8,
    challengers: [
      { accountId: "c1", acct: "chall1" },
      { accountId: "c2", acct: "chall2" },
    ],
    now: NOW,
    ...overrides,
  };
}

/** Host plus challengers c1/c2, every invite accepted. */
function acceptedGame(overrides: Partial<CreateGameInput> = {}) {
  const { game, players } = createGameInput(validCreate(overrides), CFG);
  return {
    game,
    players: players.map((p): Player => (p.role === "challenger" ? { ...p, inviteStatus: "accepted" } : p)),
  };
}

const draft = (videoId: string) => ({
  videoId,
  title: videoId,
  canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
});

describe("validateCreate (PRD §5.1)", () => {
  it.each<[string, Partial<CreateGameInput>, RegExp]>([
    ["fewer than 2 total players", { challengers: [] }, /at least 1 challenger/],
    [
      "more than 4 total players (poll cap, PRD §2.2)",
      { challengers: [1, 2, 3, 4].map((i) => ({ accountId: `c${i}`, acct: `c${i}` })) },
      /4 players/,
    ],
    ["playlist length below 8", { playlistLength: 7 }, /8/],
    ["playlist length above 12", { playlistLength: 13 }, /12/],
    [
      "duplicate challengers",
      { challengers: [{ accountId: "c1", acct: "chall1" }, { accountId: "c1", acct: "chall1" }] },
      /duplicate/i,
    ],
    ["challenger == host", { challengers: [{ accountId: "host1", acct: "host" }] }, /duplicate|host/i],
    ["empty theme", { theme: "  " }, /theme/i],
    ["theme over the post-safe limit", { theme: "x".repeat(MAX_THEME_LENGTH + 1) }, /at most/i],
  ])("rejects %s", (_case, overrides, error) => {
    expect(() => validateCreate(validCreate(overrides))).toThrow(error);
  });

  it.each([8, 12])("accepts playlist length %i (range bound)", (playlistLength) => {
    expect(() => validateCreate(validCreate({ playlistLength }))).not.toThrow();
  });
});

describe("createGameInput", () => {
  it("builds INVITED game with deadlines and DM targets", () => {
    const { game, players } = createGameInput(validCreate(), { ...CFG, id: "game-1" });
    expect(game.status).toBe("INVITED");
    expect(game.id).toBe("game-1");
    expect(game.playlistLength).toBe(8);
    expect(game.acceptanceDeadline).toBe("2026-09-22T12:00:00.000Z");
    expect(players).toHaveLength(3);
    expect(players.find((p) => p.accountId === "host1")).toMatchObject({ role: "host", inviteStatus: "accepted" });
    expect(players.filter((p) => p.role === "challenger").every((p) => p.inviteStatus === "pending")).toBe(true);
  });
});

describe("acceptInvite / declineInvite (PRD §5.2)", () => {
  const pending = createGameInput(validCreate(), CFG);

  it("first accept moves game to COLLECTING", () => {
    const { game, players } = acceptInvite(pending.game, pending.players, "c1");
    expect(game.status).toBe("COLLECTING");
    expect(players.find((p) => p.accountId === "c1")?.inviteStatus).toBe("accepted");
  });

  it("second accept keeps COLLECTING, both accepted", () => {
    const step1 = acceptInvite(pending.game, pending.players, "c1");
    const step2 = acceptInvite(step1.game, step1.players, "c2");
    expect(step2.game.status).toBe("COLLECTING");
    expect(step2.players.filter((p) => p.inviteStatus === "accepted")).toHaveLength(3);
  });

  it("declines mark players declined; game stays INVITED until the timer, even with none accepted", () => {
    const s1 = declineInvite(pending.game, pending.players, "c1");
    const s2 = declineInvite(s1.game, s1.players, "c2");
    expect(s2.game.status).toBe("INVITED");
    expect(s2.players.filter((p) => p.inviteStatus === "declined")).toHaveLength(2);
  });

  it("rejects accept from non-challenger", () => {
    expect(() => acceptInvite(pending.game, pending.players, "stranger")).toThrow(/invite/i);
  });

  it("rejects accept after decline by same player", () => {
    const d = declineInvite(pending.game, pending.players, "c1");
    expect(() => acceptInvite(d.game, d.players, "c1")).toThrow(/declined|invite/i);
  });
});

describe("submitTune (PRD §5.3)", () => {
  const { game, players } = acceptedGame();
  const collecting = { ...game, status: "COLLECTING" as const, submissionDeadline: "2099-09-22T12:00:00.000Z" };

  it("appends tune in submission order = play order", () => {
    let tunes: Tune[] = [];
    tunes = submitTune(collecting, players, tunes, "host1", draft("aaaaaaaaaaa"));
    tunes = submitTune(collecting, players, tunes, "host1", draft("bbbbbbbbbbb"));
    expect(tunes.map((t) => [t.position, t.videoId])).toEqual([
      [1, "aaaaaaaaaaa"],
      [2, "bbbbbbbbbbb"],
    ]);
  });

  it("rejects duplicate video within same playlist (PRD §7)", () => {
    const tunes = submitTune(collecting, players, [], "host1", draft("aaaaaaaaaaa"));
    expect(() => submitTune(collecting, players, tunes, "host1", draft("aaaaaaaaaaa"))).toThrow(/already/i);
  });

  it("rejects submission beyond playlist length", () => {
    let tunes: Tune[] = [];
    for (let i = 0; i < 8; i++) {
      tunes = submitTune(collecting, players, tunes, "host1", draft(`id${String(i).padStart(9, "0")}`));
    }
    expect(tunes).toHaveLength(8);
    expect(() => submitTune(collecting, players, tunes, "host1", draft("overflow001"))).toThrow(/8/);
  });

  it("rejects submission from non-player", () => {
    expect(() => submitTune(collecting, players, [], "stranger", draft("aaaaaaaaaaa"))).toThrow(/player/i);
  });

  it("rejects submission after the submission deadline", () => {
    const expired = { ...collecting, submissionDeadline: "2026-09-22T12:00:00.000Z" };
    expect(() =>
      submitTune(expired, players, [], "host1", draft("late0000001"), undefined, new Date("2026-09-23T00:00:00.000Z")),
    ).toThrow(/not accepting|collecting|submission/i);
  });
});

describe("finalizeCollection (PRD §5.4, §7; v1.1 1.1 full commitment)", () => {
  function finalize(lengths: Record<string, number>) {
    const challengers = Object.keys(lengths)
      .filter((id) => id !== "host1")
      .map((id) => ({ accountId: id, acct: id }));
    const { game, players } = acceptedGame({ challengers });
    const collecting = { ...game, status: "COLLECTING" as const, submissionDeadline: "2026-09-24T12:00:00.000Z" };
    const tunes = players.flatMap((p) =>
      Array.from({ length: lengths[p.accountId] ?? 0 }, (_, i) => ({
        accountId: p.accountId,
        position: i + 1,
        ...draft(`${p.accountId}${String(i).padStart(9, "0")}`),
      })),
    );
    return finalizeCollection(collecting, players, tunes, 8, NOW);
  }

  it("all complete → READY", () => {
    const r = finalize({ host1: 8, c1: 8 });
    expect(r.outcome).toBe("ready");
    expect(r.game.status).toBe("READY");
    expect(r.game.updatedAt).toBe(NOW.toISOString());
    expect(r.players.filter((p) => p.inviteStatus === "accepted")).toHaveLength(2);
  });

  it("zero complete → FIZZLED", () => {
    const r = finalize({ host1: 0, c1: 0 });
    expect(r.outcome).toBe("fizzled");
    expect(r.game.status).toBe("FIZZLED");
  });

  it("exactly one complete (other at 7/8) → default win, incomplete player withdraws", () => {
    const r = finalize({ host1: 8, c1: 7 });
    expect(r.outcome).toBe("default_win");
    expect(r.game.status).toBe("FINALE");
    expect(r.defaultWinnerId).toBe("host1");
    expect(r.players.find((p) => p.accountId === "c1")?.inviteStatus).toBe("declined");
  });

  it.each([5, 0])("≥2 complete + a player with %i tunes → READY; that player withdraws", (c2) => {
    const r = finalize({ host1: 8, c1: 8, c2 });
    expect(r.outcome).toBe("ready");
    expect(r.players.find((p) => p.accountId === "c2")?.inviteStatus).toBe("declined");
  });
});

describe("startRound / resolveRound", () => {
  const { game, players } = acceptedGame();

  function resolveAt(roundNumber: number, pot: number, votes: number[]) {
    const tallies = votes.map((v, i) => ({ accountId: ["host1", "c1", "c2"][i]!, votes: v }));
    return resolveRound({
      game: { ...game, status: "ROUND", currentRound: roundNumber, pot },
      players,
      tallies,
      roundNumber,
      now: NOW,
    });
  }

  const pointsOf = (r: { players: Player[] }) => r.players.map((p) => p.points);

  it("startRound moves READY → ROUND and sets current_round=1", () => {
    const g = startRound({ ...game, status: "READY" }, 1);
    expect(g.status).toBe("ROUND");
    expect(g.currentRound).toBe(1);
  });

  it("resolveRound awards votes + pot, advances round number", () => {
    const r = resolveAt(1, 2, [4, 2, 1]);
    expect(r.winnerAccountId).toBe("host1");
    expect(r.game.pot).toBe(0); // taken by winner
    expect(pointsOf(r)).toEqual([4 + 2, 2, 1]); // host: 4 votes + 2 pot
    expect(r.game.currentRound).toBe(2);
    expect(r.game.status).toBe("ROUND");
  });

  it("non-final tie → votes still awarded, pot accrues (+1), no finalSplit, still advances", () => {
    const r = resolveAt(7, 2, [3, 3]);
    expect(r.winnerAccountId).toBeNull();
    expect(r.game.pot).toBe(3);
    expect(r.finalSplit).toBeNull();
    expect(pointsOf(r)).toEqual([3, 3, 0]);
    expect(r.game.currentRound).toBe(8);
  });

  it("final round resolution → FINALE, winner takes pot", () => {
    const r = resolveAt(8, 3, [5, 2, 0]);
    expect(r.game.status).toBe("FINALE");
    expect(r.winnerAccountId).toBe("host1");
    expect(r.game.pot).toBe(0);
    expect(r.finalSplit).toBeNull();
  });

  it("final round 2-way tie with pot=3 → +1 each, pot 0 (v1.1 1.3)", () => {
    const r = resolveAt(8, 3, [4, 4, 1]);
    expect(r.winnerAccountId).toBeNull();
    expect(r.game.pot).toBe(0);
    expect(r.finalSplit).toEqual({ total: 2, each: 1, count: 2 });
    expect(pointsOf(r)).toEqual([4 + 1, 4 + 1, 1]);
  });

  it("final round quorum-forced tie with unique leader → all poll participants split", () => {
    const r = resolveAt(8, 4, [2, 0, 0]);
    expect(r.winnerAccountId).toBeNull();
    expect(r.game.pot).toBe(0);
    expect(r.finalSplit).toEqual({ total: 3, each: 1, count: 3 });
  });
});
