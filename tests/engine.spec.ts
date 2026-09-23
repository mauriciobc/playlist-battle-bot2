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
import type { Tune } from "../src/game/types.js";

const NOW = new Date("2026-09-21T12:00:00Z");

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

describe("validateCreate (PRD §5.1)", () => {
  it("accepts a valid 3-player game", () => {
    expect(() => validateCreate(validCreate())).not.toThrow();
  });

  it("rejects fewer than 2 total players", () => {
    expect(() => validateCreate(validCreate({ challengers: [] }))).toThrow(/at least 1 challenger/);
  });

  it("rejects more than 4 total players (poll cap, PRD §2.2)", () => {
    expect(() =>
      validateCreate(
        validCreate({
          challengers: [1, 2, 3, 4].map((i) => ({ accountId: `c${i}`, acct: `c${i}` })),
        }),
      ),
    ).toThrow(/4 players/);
  });

  it("rejects playlist length outside 8–12", () => {
    expect(() => validateCreate(validCreate({ playlistLength: 7 }))).toThrow(/8/);
    expect(() => validateCreate(validCreate({ playlistLength: 13 }))).toThrow(/12/);
    expect(() => validateCreate(validCreate({ playlistLength: 8 }))).not.toThrow();
    expect(() => validateCreate(validCreate({ playlistLength: 12 }))).not.toThrow();
  });

  it("accepts remote challengers (federated players)", () => {
    expect(() =>
      validateCreate(
        validCreate({
          challengers: [{ accountId: "remote", acct: "x@other.social" }],
        }),
      ),
    ).not.toThrow();
  });

  it("accepts a remote host (federated host)", () => {
    expect(() =>
      validateCreate(
        validCreate({
          host: { accountId: "remote-host", acct: "y@other.social" },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects duplicate challengers / challenger == host", () => {
    expect(() =>
      validateCreate(
        validCreate({
          challengers: [
            { accountId: "c1", acct: "chall1" },
            { accountId: "c1", acct: "chall1" },
          ],
        }),
      ),
    ).toThrow(/duplicate/i);
    expect(() =>
      validateCreate(
        validCreate({
          challengers: [{ accountId: "host1", acct: "host" }],
        }),
      ),
    ).toThrow(/duplicate|host/i);
  });

  it("rejects empty theme", () => {
    expect(() => validateCreate(validCreate({ theme: "  " }))).toThrow(/theme/i);
  });

  it("rejects themes over the post-safe limit", () => {
    expect(() => validateCreate(validCreate({ theme: "x".repeat(MAX_THEME_LENGTH + 1) }))).toThrow(
      /at most/i,
    );
  });
});

describe("createGameInput", () => {
  it("builds INVITED game with deadlines and DM targets", () => {
    const { game, players } = createGameInput(validCreate(), {
      pollDurationSec: 86400,
      acceptanceWindowSec: 86400,
      id: "game-1",
    });
    expect(game.status).toBe("INVITED");
    expect(game.id).toBe("game-1");
    expect(game.playlistLength).toBe(8);
    expect(game.acceptanceDeadline).toBe("2026-09-22T12:00:00.000Z");
    expect(players).toHaveLength(3);
    expect(players.find((p) => p.accountId === "host1")?.role).toBe("host");
    expect(players.filter((p) => p.role === "challenger").every((p) => p.inviteStatus === "pending")).toBe(true);
    expect(players.find((p) => p.accountId === "host1")?.inviteStatus).toBe("accepted");
  });
});

describe("acceptInvite / declineInvite (PRD §5.2)", () => {
  const pending = createGameInput(validCreate(), { pollDurationSec: 86400, acceptanceWindowSec: 86400, id: "g" });

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

  it("decline marks declined; game stays INVITED until window", () => {
    const { game, players } = declineInvite(pending.game, pending.players, "c2");
    expect(game.status).toBe("INVITED");
    expect(players.find((p) => p.accountId === "c2")?.inviteStatus).toBe("declined");
  });

  it("decline when it was the only pending challenger and none accepted → still INVITED (wait for timer)", () => {
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
  function setupCollecting() {
    const base = createGameInput(validCreate(), { pollDurationSec: 86400, acceptanceWindowSec: 86400, id: "g" });
    const collected = {
      ...base.game,
      status: "COLLECTING" as const,
      submissionDeadline: "2099-09-22T12:00:00.000Z",
    };
    const players = base.players.map((p) =>
      p.role === "challenger" ? { ...p, inviteStatus: "accepted" as const } : p,
    );
    return { collected, players };
  }

  it("appends tune in submission order = play order", () => {
    const { collected, players } = setupCollecting();
    let tunes: Tune[] = [];
    tunes = submitTune(collected, players, tunes, "host1", {
      videoId: "aaaaaaaaaaa",
      title: "First",
      canonicalUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    });
    tunes = submitTune(collected, players, tunes, "host1", {
      videoId: "bbbbbbbbbbb",
      title: "Second",
      canonicalUrl: "https://www.youtube.com/watch?v=bbbbbbbbbbb",
    });
    expect(tunes.map((t) => t.position)).toEqual([1, 2]);
    expect(tunes[0]!.videoId).toBe("aaaaaaaaaaa");
  });

  it("rejects duplicate video within same playlist (PRD §7)", () => {
    const { collected, players } = setupCollecting();
    const tunes = submitTune(collected, players, [], "host1", {
      videoId: "aaaaaaaaaaa",
      title: "One",
      canonicalUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    });
    expect(() =>
      submitTune(collected, players, tunes, "host1", {
        videoId: "aaaaaaaaaaa",
        title: "One again",
        canonicalUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
      }),
    ).toThrow(/already/i);
  });

  it("rejects submission beyond playlist length", () => {
    const base = createGameInput(validCreate({ playlistLength: 8 }), {
      pollDurationSec: 86400,
      acceptanceWindowSec: 86400,
      id: "g",
    });
    const collected = {
      ...base.game,
      status: "COLLECTING" as const,
      submissionDeadline: "2099-09-22T12:00:00.000Z",
    };
    const players = base.players.map((p) =>
      p.role === "challenger" ? { ...p, inviteStatus: "accepted" as const } : p,
    );
    let tunes: Tune[] = [];
    for (let i = 0; i < 8; i++) {
      const id = `id${String(i).padStart(9, "0")}`;
      tunes = submitTune(collected, players, tunes, "host1", {
        videoId: id,
        title: `T${i}`,
        canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
      });
    }
    expect(tunes).toHaveLength(8);
    expect(() =>
      submitTune(collected, players, tunes, "host1", {
        videoId: "overflow001",
        title: "Nope",
        canonicalUrl: "https://www.youtube.com/watch?v=overflow001",
      }),
    ).toThrow(/8/);
  });

  it("rejects submission from non-player", () => {
    const { collected, players } = setupCollecting();
    expect(() =>
      submitTune(collected, players, [], "stranger", {
        videoId: "aaaaaaaaaaa",
        title: "X",
        canonicalUrl: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
      }),
    ).toThrow(/player/i);
  });

  it("rejects submission after the submission deadline", () => {
    const { collected, players } = setupCollecting();
    const expired = { ...collected, submissionDeadline: "2026-09-22T12:00:00.000Z" };
    expect(() =>
      submitTune(
        expired,
        players,
        [],
        "host1",
        {
          videoId: "late0000001",
          title: "Late",
          canonicalUrl: "https://www.youtube.com/watch?v=late0000001",
        },
        undefined,
        new Date("2026-09-23T00:00:00.000Z"),
      ),
    ).toThrow(/not accepting|collecting|submission/i);
  });
});

describe("finalizeCollection (PRD §5.4, §7)", () => {
  function setup(playersCount: 2 | 3, lengths: Record<string, number>) {
    const input = validCreate(
      playersCount === 3
        ? {}
        : { challengers: [{ accountId: "c1", acct: "chall1" }] },
    );
    const { game, players } = createGameInput(input, {
      pollDurationSec: 86400,
      acceptanceWindowSec: 86400,
      id: "g",
    });
    const collecting = { ...game, status: "COLLECTING" as const, submissionDeadline: "2026-09-24T12:00:00.000Z" };
    const accepted = players.map((p) =>
      p.inviteStatus === "pending" && p.role === "challenger"
        ? { ...p, inviteStatus: "accepted" as const, joinedAt: NOW.toISOString() }
        : p,
    );
    const tunes = accepted.flatMap((p) => {
      const n = lengths[p.accountId] ?? 0;
      return Array.from({ length: n }, (_, i) => ({
        accountId: p.accountId,
        position: i + 1,
        videoId: `${p.accountId}${String(i).padStart(9, "0")}`,
        title: `T${i}`,
        canonicalUrl: `https://www.youtube.com/watch?v=${p.accountId}${String(i).padStart(9, "0")}`,
      }));
    });
    return { collecting, accepted, tunes };
  }

  it("all complete → READY", () => {
    const { collecting, accepted, tunes } = setup(2, { host1: 8, c1: 8 });
    const r = finalizeCollection(collecting, accepted, tunes, 8, NOW);
    expect(r.outcome).toBe("ready");
    expect(r.game.status).toBe("READY");
  });

  it("zero complete → FIZZLED", () => {
    const { collecting, accepted, tunes } = setup(2, { host1: 0, c1: 0 });
    const r = finalizeCollection(collecting, accepted, tunes, 8, NOW);
    expect(r.outcome).toBe("fizzled");
    expect(r.game.status).toBe("FIZZLED");
  });

  it("exactly one complete → default win (last one standing)", () => {
    const { collecting, accepted, tunes } = setup(2, { host1: 8, c1: 3 });
    const r = finalizeCollection(collecting, accepted, tunes, 8, NOW);
    expect(r.outcome).toBe("default_win");
    expect(r.game.status).toBe("FINALE");
    expect(r.defaultWinnerId).toBe("host1");
  });

  it("≥2 complete + partial player → READY; partial player withdraws (v1.1 1.1 full commitment)", () => {
    const { collecting, accepted, tunes } = setup(3, { host1: 8, c1: 8, c2: 5 });
    const r = finalizeCollection(collecting, accepted, tunes, 8, NOW);
    expect(r.outcome).toBe("ready");
    const c2 = r.players.find((p) => p.accountId === "c2");
    expect(c2?.inviteStatus).toBe("declined");
  });

  it("7/8-valid playlist at deadline → withdrawal (v1.1 1.1 acceptance)", () => {
    const { collecting, accepted, tunes } = setup(2, { host1: 8, c1: 7 });
    const r = finalizeCollection(collecting, accepted, tunes, 8, NOW);
    expect(r.outcome).toBe("default_win");
    expect(r.defaultWinnerId).toBe("host1");
    const c1 = r.players.find((p) => p.accountId === "c1");
    expect(c1?.inviteStatus).toBe("declined");
  });

  it("8/8 → READY (v1.1 1.1 acceptance)", () => {
    const { collecting, accepted, tunes } = setup(2, { host1: 8, c1: 8 });
    const r = finalizeCollection(collecting, accepted, tunes, 8, NOW);
    expect(r.outcome).toBe("ready");
    expect(r.players.filter((p) => p.inviteStatus === "accepted")).toHaveLength(2);
  });

  it("player with 0 tunes dropped entirely (never submitted)", () => {
    const { collecting, accepted, tunes } = setup(3, { host1: 8, c1: 8, c2: 0 });
    const r = finalizeCollection(collecting, accepted, tunes, 8, NOW);
    expect(r.outcome).toBe("ready");
    const c2 = r.players.find((p) => p.accountId === "c2");
    expect(c2?.inviteStatus).toBe("declined"); // dropped
  });

  it("sets submission deadline passed state consistently", () => {
    const { collecting, accepted, tunes } = setup(2, { host1: 8, c1: 8 });
    const r = finalizeCollection(collecting, accepted, tunes, 8, NOW);
    expect(r.game.updatedAt).toBe(NOW.toISOString());
  });
});

describe("startRound / resolveRound", () => {
  it("startRound moves READY → ROUND and sets current_round=1", () => {
    const base = createGameInput(validCreate(), { pollDurationSec: 86400, acceptanceWindowSec: 86400, id: "g" });
    const ready = { ...base.game, status: "READY" as const };
    const g = startRound(ready, 1);
    expect(g.status).toBe("ROUND");
    expect(g.currentRound).toBe(1);
  });

  it("resolveRound awards votes + pot, advances round number", () => {
    const base = createGameInput(validCreate(), { pollDurationSec: 86400, acceptanceWindowSec: 86400, id: "g" });
    const roundGame = { ...base.game, status: "ROUND" as const, currentRound: 1, pot: 2 };
    const players = base.players.map((p) =>
      p.inviteStatus === "pending" && p.role === "challenger"
        ? { ...p, inviteStatus: "accepted" as const }
        : p,
    );
    const r = resolveRound({
      game: roundGame,
      players,
      tallies: [
        { accountId: "host1", votes: 4 },
        { accountId: "c1", votes: 2 },
        { accountId: "c2", votes: 1 },
      ],
      roundNumber: 1,
      playlistLength: 8,
      now: NOW,
    });
    expect(r.winnerAccountId).toBe("host1");
    expect(r.game.pot).toBe(0); // taken by winner
    expect(r.players.find((p) => p.accountId === "host1")?.points).toBe(4 + 2); // 4 votes + 2 pot
    expect(r.players.find((p) => p.accountId === "c1")?.points).toBe(2);
    expect(r.game.currentRound).toBe(2);
    expect(r.game.status).toBe("ROUND");
    expect(r.nextState).toBe("ROUND");
  });

  it("tie round → pot accrues, no winner, still advances", () => {
    const base = createGameInput(validCreate(), { pollDurationSec: 86400, acceptanceWindowSec: 86400, id: "g" });
    const roundGame = { ...base.game, status: "ROUND" as const, currentRound: 1, pot: 0 };
    const players = base.players.map((p) =>
      p.role === "challenger" ? { ...p, inviteStatus: "accepted" as const } : p,
    );
    const r = resolveRound({
      game: roundGame,
      players,
      tallies: [
        { accountId: "host1", votes: 3 },
        { accountId: "c1", votes: 3 },
        { accountId: "c2", votes: 1 },
      ],
      roundNumber: 1,
      playlistLength: 8,
      now: NOW,
    });
    expect(r.winnerAccountId).toBeNull();
    expect(r.game.pot).toBe(1);
    expect(r.players.every((p) => p.points >= 0)).toBe(true);
    expect(r.players.find((p) => p.accountId === "host1")?.points).toBe(3);
  });

  it("final round resolution → FINALE (nextState=FINALE), winner takes pot", () => {
    const base = createGameInput(validCreate({ playlistLength: 8 }), {
      pollDurationSec: 86400,
      acceptanceWindowSec: 86400,
      id: "g",
    });
    const roundGame = { ...base.game, status: "ROUND" as const, currentRound: 8, pot: 3 };
    const players = base.players.map((p) =>
      p.role === "challenger" ? { ...p, inviteStatus: "accepted" as const } : p,
    );
    const r = resolveRound({
      game: roundGame,
      players,
      tallies: [
        { accountId: "host1", votes: 5 },
        { accountId: "c1", votes: 2 },
        { accountId: "c2", votes: 0 },
      ],
      roundNumber: 8,
      playlistLength: 8,
      now: NOW,
    });
    expect(r.nextState).toBe("FINALE");
    expect(r.game.status).toBe("FINALE");
    expect(r.winnerAccountId).toBe("host1");
    expect(r.game.pot).toBe(0);
    expect(r.finalSplit).toBeNull();
  });

  it("final round 2-way tie with pot=3 → +1 each, pot 0 (v1.1 1.3)", () => {
    const base = createGameInput(validCreate({ playlistLength: 8 }), {
      pollDurationSec: 86400,
      acceptanceWindowSec: 86400,
      id: "g",
    });
    const roundGame = { ...base.game, status: "ROUND" as const, currentRound: 8, pot: 3 };
    const players = base.players.map((p) =>
      p.role === "challenger" ? { ...p, inviteStatus: "accepted" as const } : p,
    );
    const r = resolveRound({
      game: roundGame,
      players,
      tallies: [
        { accountId: "host1", votes: 4 },
        { accountId: "c1", votes: 4 },
        { accountId: "c2", votes: 1 },
      ],
      roundNumber: 8,
      playlistLength: 8,
      now: NOW,
    });
    expect(r.winnerAccountId).toBeNull();
    expect(r.game.pot).toBe(0);
    expect(r.finalSplit).toEqual({ total: 2, each: 1, count: 2 });
    expect(r.players.find((p) => p.accountId === "host1")?.points).toBe(4 + 1);
    expect(r.players.find((p) => p.accountId === "c1")?.points).toBe(4 + 1);
    expect(r.players.find((p) => p.accountId === "c2")?.points).toBe(1);
  });

  it("final round quorum-forced tie with unique leader → all poll participants split", () => {
    const base = createGameInput(validCreate({ playlistLength: 8 }), {
      pollDurationSec: 86400,
      acceptanceWindowSec: 86400,
      id: "g",
    });
    const roundGame = { ...base.game, status: "ROUND" as const, currentRound: 8, pot: 4 };
    const players = base.players.map((p) =>
      p.role === "challenger" ? { ...p, inviteStatus: "accepted" as const } : p,
    );
    const r = resolveRound({
      game: roundGame,
      players,
      tallies: [
        { accountId: "host1", votes: 2 },
        { accountId: "c1", votes: 0 },
        { accountId: "c2", votes: 0 },
      ],
      roundNumber: 8,
      playlistLength: 8,
      now: NOW,
    });
    expect(r.winnerAccountId).toBeNull();
    expect(r.game.pot).toBe(0);
    expect(r.finalSplit).toEqual({ total: 3, each: 1, count: 3 });
  });

  it("non-final tie still accrues pot (+1), no finalSplit", () => {
    const base = createGameInput(validCreate({ playlistLength: 8 }), {
      pollDurationSec: 86400,
      acceptanceWindowSec: 86400,
      id: "g",
    });
    const roundGame = { ...base.game, status: "ROUND" as const, currentRound: 7, pot: 2 };
    const players = base.players.map((p) =>
      p.role === "challenger" ? { ...p, inviteStatus: "accepted" as const } : p,
    );
    const r = resolveRound({
      game: roundGame,
      players,
      tallies: [
        { accountId: "host1", votes: 3 },
        { accountId: "c1", votes: 3 },
      ],
      roundNumber: 7,
      playlistLength: 8,
      now: NOW,
    });
    expect(r.winnerAccountId).toBeNull();
    expect(r.game.pot).toBe(3);
    expect(r.finalSplit).toBeNull();
  });
});


