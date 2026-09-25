import { beforeEach, describe, expect, it } from "vitest";
import { checkDeadlines, checkPollNotification, checkPolls, resumeOpenGames } from "../src/scheduler/index.js";
import { emitRound } from "../src/scheduler/roundState.js";
import { m } from "../src/i18n/index.js";
import {
  FUTURE,
  gameRow,
  NOW,
  PAST,
  playerRow,
  pollEntrants,
  roundRow,
  seedDuel,
  seedGame,
  seedPlayer,
  seedPlaylist,
  seedPollRound,
  seedResolvedRounds,
  useHarness,
} from "./support.js";

describe("checkDeadlines — acceptance window (PRD §5.2)", () => {
  const h = useHarness();
  function seedInvited(acceptanceDeadline: string): string {
    const id = seedGame(h.db, { status: "INVITED", acceptanceDeadline });
    seedPlayer(h.db, id, "host1");
    seedPlayer(h.db, id, "alice", { invite: "pending" });
    return id;
  }

  it("expires INVITED game past deadline with zero accepts → EXPIRED + creation-post reply", async () => {
    const id = seedInvited(PAST);

    await checkDeadlines(h.sched);

    expect(gameRow(h.db, id).status).toBe("EXPIRED");
    expect(h.posts.map((p) => p.body)).toEqual([
      expect.objectContaining({ in_reply_to_id: "root-1", status: m().sideExpired("Theme") }),
    ]);
  });

  it("does not expire INVITED game before deadline", async () => {
    const id = seedInvited(FUTURE);

    await checkDeadlines(h.sched);

    expect(gameRow(h.db, id).status).toBe("INVITED");
    expect(h.posts).toHaveLength(0);
  });

  it("closing the window with ≥1 accept keeps the game COLLECTING and expires pending invites", async () => {
    const id = seedGame(h.db, { status: "COLLECTING", acceptanceDeadline: PAST, submissionDeadline: FUTURE });
    seedPlayer(h.db, id, "host1");
    seedPlayer(h.db, id, "alice");
    seedPlayer(h.db, id, "bob", { invite: "pending" });

    await checkDeadlines(h.sched);

    expect(gameRow(h.db, id).status).toBe("COLLECTING");
    expect(playerRow(h.db, id, "bob").invite_status).toBe("expired");
  });
});

describe("checkDeadlines — submission window (PRD §5.4/§7)", () => {
  const h = useHarness();
  function seedCollecting(submissionDeadline = PAST): string {
    const id = seedGame(h.db, { status: "COLLECTING", submissionDeadline });
    seedPlayer(h.db, id, "host1");
    seedPlayer(h.db, id, "alice");
    return id;
  }

  it("zero complete playlists → FIZZLED with creation-post notice", async () => {
    const id = seedCollecting();
    seedPlaylist(h.db, id, "alice", { count: 1 });

    await checkDeadlines(h.sched);

    expect(gameRow(h.db, id).status).toBe("FIZZLED");
    expect(h.texts()).toContain(m().sideFizzled("Theme"));
  });

  it("exactly one complete playlist → default win, finale posted, CLOSED", async () => {
    const id = seedCollecting();
    seedPlaylist(h.db, id, "host1");
    seedPlaylist(h.db, id, "alice", { count: 3 });

    await checkDeadlines(h.sched);

    expect(gameRow(h.db, id).status).toBe("CLOSED");
    expect(h.texts()).toContain(m().sideDefaultWin("Theme", "host1"));
  });

  it("2 complete + 1 partial → round 1 opens; the partial player withdraws (v1.1 full commitment)", async () => {
    const id = seedCollecting();
    seedPlayer(h.db, id, "bob");
    seedPlaylist(h.db, id, "host1");
    seedPlaylist(h.db, id, "alice");
    seedPlaylist(h.db, id, "bob", { count: 5 });

    await checkDeadlines(h.sched);

    expect(gameRow(h.db, id)).toMatchObject({ status: "ROUND", current_round: 1 });
    expect(playerRow(h.db, id, "bob").invite_status).toBe("declined");
    expect(roundRow(h.db, id, 1)!.status).toBe("poll_open");
    expect(pollEntrants(h.db, id, 1).sort()).toEqual(["alice", "host1"]);
  });

  it("a restart before the deadline neither closes collection nor withdraws partial submissions", async () => {
    const id = seedCollecting(FUTURE);
    seedPlaylist(h.db, id, "host1", { count: 3 });

    await resumeOpenGames(h.sched);

    expect(gameRow(h.db, id).status).toBe("COLLECTING");
    expect(playerRow(h.db, id, "host1").invite_status).toBe("accepted");
  });
});

describe("checkPolls — poll expiry tally (PRD §5.5/§5.6)", () => {
  const h = useHarness();
  const pointsOf = (gameId: string, accountId: string) => playerRow(h.db, gameId, accountId).points;

  it("expired poll → tallies votes, awards points + pot, advances to round 2", async () => {
    const id = seedDuel(h.db, { currentRound: 1, pot: 2 });
    seedPollRound(h.db, id);

    await checkPolls(h.sched);

    expect(gameRow(h.db, id)).toMatchObject({ status: "ROUND", current_round: 2, pot: 0 });
    expect(pointsOf(id, "host1")).toBe(5 + 2); // votes + pot bonus
    expect(pointsOf(id, "alice")).toBe(3);
    expect(roundRow(h.db, id, 1)).toMatchObject({ status: "resolved", winner_account_id: "host1" });
    expect(h.texts().join("\n")).toContain(m().resolutionWin(1, "host1", 2));
    expect(roundRow(h.db, id, 2)!.status).toBe("poll_open");
  });

  it("tied poll → pot accrues, votes still count, advances round", async () => {
    h.poll.votes = [4, 4];
    const id = seedDuel(h.db, { currentRound: 1, pot: 1 });
    seedPollRound(h.db, id);

    await checkPolls(h.sched);

    expect(gameRow(h.db, id)).toMatchObject({ status: "ROUND", current_round: 2, pot: 2 });
    expect(pointsOf(id, "host1")).toBe(4);
  });

  it("does not tally polls that have not expired", async () => {
    const id = seedDuel(h.db, { currentRound: 1 });
    seedPollRound(h.db, id, { expiresAt: FUTURE });

    await checkPolls(h.sched);

    expect(gameRow(h.db, id).current_round).toBe(1);
    expect(roundRow(h.db, id, 1)!.status).toBe("poll_open");
    expect(h.client.get).not.toHaveBeenCalled();
  });

  it("skips open polls of games already terminal", async () => {
    const id = seedGame(h.db, { status: "CLOSED", currentRound: 1 });
    seedPollRound(h.db, id);

    await checkPolls(h.sched);

    expect(h.client.get).not.toHaveBeenCalled();
  });

  it("final round poll expiry → finale root post + CLOSED, pot awarded", async () => {
    const id = seedDuel(h.db, { currentRound: 8, pot: 3, points: [10, 7] });
    seedResolvedRounds(h.db, id, Array(7).fill("host1"));
    seedPollRound(h.db, id, { round: 8 });

    await checkPolls(h.sched);

    expect(gameRow(h.db, id).status).toBe("CLOSED");
    const rootPosts = h.posts.filter((p) => !p.body.in_reply_to_id);
    expect(rootPosts.at(-1)!.body.status).toContain(m().champion("@host1"));
    expect(pointsOf(id, "host1")).toBe(10 + 5 + 3); // prior + final votes + pot
  });

  it("overlapping sweep and poll-expired fast path resolve the round exactly once", async () => {
    const id = seedDuel(h.db, { currentRound: 1, pot: 1 });
    seedPollRound(h.db, id);

    await Promise.all([checkPolls(h.sched), checkPollNotification(h.sched, "poll-status")]);

    expect(pointsOf(id, "host1")).toBe(5 + 1); // votes + pot, awarded once (not doubled)
    expect(roundRow(h.db, id, 1)).toMatchObject({ status: "resolved", winner_account_id: "host1" });
    expect(gameRow(h.db, id).current_round).toBe(2); // advanced once
    expect(h.texts().filter((t) => t.includes(m().resolutionWin(1, "host1", 1)))).toHaveLength(1);
  });

  it("a player in several open games: resolving one leaves the other untouched", async () => {
    const a = seedDuel(h.db, { currentRound: 1, pot: 2, points: [10, 3] });
    const b = seedDuel(h.db, { currentRound: 1, points: [7, 2] });
    seedPollRound(h.db, a);
    seedPollRound(h.db, b, { expiresAt: FUTURE });

    await checkPolls(h.sched);

    expect(gameRow(h.db, a)).toMatchObject({ current_round: 2, pot: 0 });
    expect(gameRow(h.db, b)).toMatchObject({ status: "ROUND", current_round: 1, pot: 0 });
    expect(pointsOf(a, "host1")).toBe(10 + 5 + 2); // prior + votes + pot
    expect(pointsOf(b, "host1")).toBe(7);
  });
});

describe("resumeOpenGames — crash recovery (PRD §7)", () => {
  const h = useHarness();

  it("completes the creation effects of a persisted CREATED game", async () => {
    const id = seedGame(h.db, { status: "CREATED", acceptanceDeadline: FUTURE });
    h.db
      .prepare(
        "UPDATE games SET creation_status_id = 's-create', creation_visibility = 'public', thread_root_id = NULL WHERE id = ?",
      )
      .run(id);
    seedPlayer(h.db, id, "host1");
    seedPlayer(h.db, id, "alice", { invite: "pending" });

    await resumeOpenGames(h.sched);

    expect(gameRow(h.db, id)).toMatchObject({ status: "INVITED", thread_root_id: expect.any(String) });
    expect(h.posts.some((p) => p.body.visibility === "direct")).toBe(true);
  });

  it("READY (crash before round 1 emit) → starts round 1", async () => {
    const id = seedDuel(h.db, { status: "READY" });

    await resumeOpenGames(h.sched);

    expect(gameRow(h.db, id)).toMatchObject({ status: "ROUND", current_round: 1 });
    expect(roundRow(h.db, id, 1)!.status).toBe("poll_open");
  });

  it("FINALE with an unposted final-round result → posts it, then the finale, then closes", async () => {
    const id = seedDuel(h.db, { status: "FINALE", currentRound: 8, points: [10, 7] });
    seedResolvedRounds(h.db, id, Array(7).fill("host1"));
    h.db
      .prepare(
        `INSERT INTO rounds (game_id, number, status, winner_account_id, option_map_json, resolution_json)
         VALUES (?, 8, 'resolved', 'host1', '{}', ?)`,
      )
      .run(
        id,
        JSON.stringify({ round: 8, winnerAcct: "host1", potAwarded: 0, wasTie: false, newPot: 0, potSplit: null }),
      );

    await resumeOpenGames(h.sched);

    expect(gameRow(h.db, id).status).toBe("CLOSED");
    expect(roundRow(h.db, id, 8)!.resolution_posted_at).toBeTruthy();
    expect(h.texts().join("\n")).toMatch(/Round 8/);
    const rootPosts = h.posts.filter((p) => !p.body.in_reply_to_id);
    expect(rootPosts.at(-1)!.body.status).toContain(m().champion("@host1"));
  });

  it("continues a non-final auto-tie after a crash between result post and advance", async () => {
    const id = seedDuel(h.db, { currentRound: 2 });
    h.db
      .prepare(
        `INSERT INTO rounds (game_id, number, status, option_map_json, resolution_posted_at, resolution_json)
         VALUES (?, 2, 'auto_tied', ?, ?, ?)`,
      )
      .run(
        id,
        JSON.stringify({ participants: ["host1", "alice"] }),
        NOW,
        JSON.stringify({ round: 2, winnerAcct: null, potAwarded: 0, wasTie: true, newPot: 1 }),
      );

    await resumeOpenGames(h.sched);

    expect(gameRow(h.db, id).current_round).toBe(3);
    expect(roundRow(h.db, id, 3)!.status).toBe("poll_open");
  });

  it("recovers a missing prior poll result before continuing the current round", async () => {
    const id = seedDuel(h.db, { currentRound: 2, pot: 1, points: [2, 1] });
    h.db
      .prepare(
        `INSERT INTO rounds (game_id, number, status, winner_account_id, option_map_json, resolution_json)
         VALUES (?, 1, 'resolved', 'host1', '{}', ?)`,
      )
      .run(id, JSON.stringify({ round: 1, winnerAcct: "host1", potAwarded: 1, wasTie: false, newPot: 1 }));
    seedPollRound(h.db, id, { round: 2, expiresAt: FUTURE });

    await resumeOpenGames(h.sched);

    expect(roundRow(h.db, id, 1)!.resolution_posted_at).toBeTruthy();
    expect(h.texts().join("\n")).toMatch(/Round 1/);
  });
});

describe("emitRound — walkover + auto-tie (PRD §5.6/§7)", () => {
  const h = useHarness();

  it("final-round walkover: sole survivor takes the pot and the post shows post-award state", async () => {
    const id = seedGame(h.db, { currentRound: 8, pot: 3 });
    seedPlayer(h.db, id, "host1");
    seedPlayer(h.db, id, "alice");
    seedPlaylist(h.db, id, "host1");
    // alice has no tune at position 8 → host1 is the only eligible player
    seedPlaylist(h.db, id, "alice", { count: 7 });

    await emitRound(h.deps, id, 8);

    // a walkover opens no poll
    expect(roundRow(h.db, id, 8)).toMatchObject({ status: "walkover", winner_account_id: "host1", poll_id: null });
    // awarded, not left standing; a final-round walkover ends the game
    expect(gameRow(h.db, id)).toMatchObject({ status: "CLOSED", pot: 0 });
    expect(playerRow(h.db, id, "host1").points).toBe(3);

    // The resolution post must describe the award it just made, not the pre-award snapshot.
    const resolution = h.texts().find((t) => t.includes(m().resolutionWalkover(8, "host1", 3)));
    expect(resolution).toContain("@host1 3");
    expect(resolution).toContain(m().potLine(0));
  });

  it("auto-tie: identical videos skip the poll, grow the pot, and advance the round", async () => {
    const id = seedGame(h.db, { currentRound: 2, pot: 2 });
    for (const player of ["host1", "alice"]) {
      seedPlayer(h.db, id, player);
      // same video in round 2 for both players → automatic tie; later rounds differ
      seedPlaylist(h.db, id, player, { videos: { 2: "duplicated1" } });
    }

    await emitRound(h.deps, id, 2);

    // an automatic tie opens no poll
    expect(roundRow(h.db, id, 2)).toMatchObject({ status: "auto_tied", winner_account_id: null, poll_id: null });
    // 2 + 1 accrued, with nobody to award it to
    expect(gameRow(h.db, id)).toMatchObject({ current_round: 3, pot: 3 });
    // round 3 has distinct videos → a normal poll
    expect(roundRow(h.db, id, 3)!.status).toBe("poll_open");
    expect(h.texts().join("\n")).toContain(m().resolutionTie(2, 3));
  });

  it("ignores collisions from withdrawn players", async () => {
    const id = seedGame(h.db, { currentRound: 1 });
    seedPlayer(h.db, id, "host1");
    seedPlayer(h.db, id, "alice");
    seedPlayer(h.db, id, "bob", { invite: "declined" });
    seedPlaylist(h.db, id, "host1");
    seedPlaylist(h.db, id, "alice", { videos: { 1: "shared000001" } });
    seedPlaylist(h.db, id, "bob", { videos: { 1: "shared000001" } });

    await emitRound(h.deps, id, 1);

    expect(roundRow(h.db, id, 1)!.status).toBe("poll_open");
    expect(pollEntrants(h.db, id, 1).sort()).toEqual(["alice", "host1"]);
  });
});

describe("checkPolls — stagnation early close", () => {
  // poll duration 900s: expires NOW+600 → opened at NOW−300 → age = 300s
  const h = useHarness({ deps: { pollDurationSec: 900 } });

  beforeEach(() => {
    Object.assign(h.poll, { expired: false, votes: [0, 0] });
    h.sched.earlyClose = { enabled: true, minAgeSec: 300, stagnationSec: 300 };
  });

  function seedStagnant(o: { expiresAt: string; watchedVotes?: number; votesChangedAt?: string }): string {
    const id = seedDuel(h.db, { currentRound: 1, pollDurationSec: 900 });
    seedPollRound(h.db, id, { statusId: "poll-status-1", ...o });
    return id;
  }

  it("test-mode thresholds resolve a still-open 300s poll immediately (no waiting)", async () => {
    // Test mode cannot shorten the poll below Mastodon's 300s floor, so it
    // resolves stagnant polls as soon as the sweep runs. This is what makes a
    // full game finish in minutes instead of 8 x 5 minutes.
    const openedAt = new Date(NOW);
    h.deps.now = () => new Date(openedAt.getTime() + 15_000); // 15s after the poll opened
    h.sched.earlyClose = { enabled: true, minAgeSec: 0, stagnationSec: 0 };
    const id = seedStagnant({
      expiresAt: new Date(openedAt.getTime() + 300_000).toISOString(),
      watchedVotes: 0,
      votesChangedAt: openedAt.toISOString(),
    });

    await checkPolls(h.sched);

    expect(roundRow(h.db, id, 1)!.status).toBe("resolved");
  });

  it("stagnant zero-vote poll past min age → resolves, deletes the poll status, advances", async () => {
    const id = seedStagnant({ expiresAt: "2026-09-21T12:10:00.000Z" }); // age 300s

    await checkPolls(h.sched);

    expect(roundRow(h.db, id, 1)).toMatchObject({ status: "resolved", winner_account_id: null }); // all-zero → tie
    expect(gameRow(h.db, id)).toMatchObject({ current_round: 2, pot: 1 });
    expect(h.deleted).toContain("/api/v1/statuses/poll-status-1");
    // one GET: the watch snapshot; resolve reuses it (no second tally fetch)
    expect(h.client.get).toHaveBeenCalledTimes(1);
  });

  it("does not early-close before min age", async () => {
    const id = seedStagnant({ expiresAt: "2026-09-21T12:14:00.000Z" }); // age 60s

    await checkPolls(h.sched);

    expect(roundRow(h.db, id, 1)!.status).toBe("poll_open");
    expect(h.deleted).toHaveLength(0);
    expect(gameRow(h.db, id).current_round).toBe(1);
    expect(h.client.get).toHaveBeenCalledTimes(1); // watched, but not eligible
  });

  it("vote change on this sweep restarts the stagnation clock", async () => {
    const id = seedStagnant({
      expiresAt: "2026-09-21T12:10:00.000Z", // age 300s
      watchedVotes: 0,
      votesChangedAt: "2026-09-21T11:55:00.000Z",
    });
    h.poll.votes = [1, 1];

    await checkPolls(h.sched);

    expect(roundRow(h.db, id, 1)).toMatchObject({ status: "poll_open", watched_votes: 2, votes_changed_at: NOW });
    expect(h.deleted).toHaveLength(0);
  });

  it("stagnant poll with prior votes → resolves with the live tallies", async () => {
    const id = seedStagnant({
      expiresAt: "2026-09-21T12:10:00.000Z", // age 300s
      watchedVotes: 5,
      votesChangedAt: "2026-09-21T11:00:00.000Z", // still 3600s
    });
    h.poll.votes = [3, 2];

    await checkPolls(h.sched);

    expect(roundRow(h.db, id, 1)).toMatchObject({ status: "resolved", winner_account_id: "host1" });
    expect(playerRow(h.db, id, "host1").points).toBe(3);
    expect(h.deleted).toContain("/api/v1/statuses/poll-status-1");
    expect(gameRow(h.db, id).current_round).toBe(2);
  });

  it("disabled early close → no live poll fetches", async () => {
    const id = seedStagnant({ expiresAt: "2026-09-21T12:10:00.000Z" });
    h.sched.earlyClose = { enabled: false, minAgeSec: 300, stagnationSec: 300 };

    await checkPolls(h.sched);

    expect(h.client.get).not.toHaveBeenCalled();
    expect(roundRow(h.db, id, 1)!.status).toBe("poll_open");
  });

  it("poll status deletion failure is non-fatal — round still resolves, cleanup retried next sweep", async () => {
    const id = seedStagnant({ expiresAt: "2026-09-21T12:10:00.000Z" });
    h.client.delete.mockRejectedValueOnce(new Error("boom"));

    await expect(checkPolls(h.sched)).resolves.toBeUndefined();

    expect(roundRow(h.db, id, 1)).toMatchObject({
      status: "resolved",
      poll_cleanup_pending: 1,
      poll_status_id: "poll-status-1",
    });

    await checkPolls(h.sched);

    expect(roundRow(h.db, id, 1)).toMatchObject({ poll_cleanup_pending: 0, poll_status_id: null });
    expect(gameRow(h.db, id).current_round).toBe(2);
  });
});
