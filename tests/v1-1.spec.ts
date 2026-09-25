import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index.js";
import { checkAvailable } from "../src/youtube/oembed.js";
import { handleDm, type HandlerDeps } from "../src/handlers/mention.js";
import { checkDeadlines } from "../src/scheduler/index.js";
import { emitFinale, emitRound } from "../src/scheduler/roundState.js";
import { m } from "../src/i18n/index.js";
import { MastodonApiError } from "../src/mastodon/client.js";
import {
  accept,
  count,
  createHarness,
  FUTURE,
  gameRow,
  input,
  link,
  newGame,
  NOW,
  pollEntrants,
  roundRow,
  seedGame,
  seedPlayer,
  seedPlaylist,
  seedPollRound,
  seedResolvedRounds,
  useHarness,
  videoId,
  type SeedGame,
} from "./support.js";

// ── checkAvailable (v1.1 1.4) ─────────────────────────────────────

describe("checkAvailable (v1.1 1.4)", () => {
  const VID = "dQw4w9WgXcQ";
  const check = (fetchImpl: () => Promise<Response>, id = VID) =>
    checkAvailable(id, { fetchImpl: fetchImpl as unknown as typeof fetch });
  const respond = (status: number, body: unknown) => async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it.each([
    ["404 → unavailable", 404, {}, false],
    ["429 → available (fail-open, rate limited)", 429, {}, true],
    ["5xx → available (fail-open, transient)", 503, {}, true],
    ["200 with title → available", 200, { title: "T", author_name: "A" }, true],
    ["200 without title → unavailable", 200, { provider_name: "YouTube" }, false],
  ])("%s", async (_, status, body, expected) => {
    await expect(check(respond(status, body))).resolves.toBe(expected);
  });

  it("network error → available (fail-open)", async () => {
    await expect(
      check(async () => {
        throw new Error("boom");
      }),
    ).resolves.toBe(true);
  });

  it("invalid video ID → unavailable without a fetch", async () => {
    const fetchImpl = vi.fn(respond(200, { title: "T" }));
    await expect(check(fetchImpl, "!!!")).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

/**
 * A game hosted by id-host with players `id-<name>` (acct `<name>`), each with
 * a complete playlist of `id-<name>-<pos>` videos.
 */
function seedTable(db: Db, o: SeedGame = {}, names = ["host", "alice"]): string {
  const id = seedGame(db, { host: "id-host", ...o });
  for (const name of names) {
    seedPlayer(db, id, `id-${name}`, { acct: name });
    seedPlaylist(db, id, `id-${name}`);
  }
  return id;
}

const tuneAt = (db: Db, gameId: string, accountId: string, position: number) =>
  (db
    .prepare("SELECT video_id FROM tunes WHERE game_id = ? AND account_id = ? AND position = ?")
    .get(gameId, accountId, position) as { video_id: string }).video_id;

// ── replace DM (v1.1 1.6) + edit-until-deadline ──────────────────

describe("replace DM (v1.1 1.6) + edit-until-deadline", () => {
  const h = useHarness();
  const GAME = "game-1";
  const hostDm = (content: string) => handleDm(input("id-host", `<p>${content}</p>`), h.deps);

  async function collecting(): Promise<void> {
    await newGame(h.deps);
    await accept(h.deps, "id-alice");
  }

  it("replace <n> <url> swaps the tune", async () => {
    await collecting();
    await hostDm(link(videoId("a", 1)));

    expect(await hostDm(`replace 1 https://youtu.be/${videoId("b", 2)}`)).toMatchObject({
      handled: true,
      kind: "tune_replaced",
    });
    expect(tuneAt(h.db, GAME, "id-host", 1)).toBe(videoId("b", 2));
  });

  it.each([
    { name: "out of range", submitted: [], command: `replace 9 https://youtu.be/${videoId("z")}`, detail: "position out of range" },
    { name: "no tune at the position", submitted: [], command: `replace 3 https://youtu.be/${videoId("z")}`, detail: "no tune at position" },
    { name: "a duplicate video", submitted: [videoId("a"), videoId("b")], command: `replace 1 https://youtu.be/${videoId("b")}`, detail: "duplicate" },
    { name: "an unplayable URL", submitted: [videoId("a")], command: "replace 1 https://vimeo.com/123", detail: "not playable" },
  ])("replace is rejected for $name", async ({ submitted, command, detail }) => {
    await collecting();
    for (const vid of submitted) await hostDm(link(vid));

    expect(await hostDm(command)).toMatchObject({ handled: true, kind: "replace_rejected", detail });
  });

  it("replace with no collecting game → not collecting", async () => {
    const r = await handleDm(input("id-ghost", `<p>replace 1 https://youtu.be/${videoId("z")}</p>`), h.deps);
    expect(r).toMatchObject({ handled: true, kind: "replace_rejected", detail: "not collecting" });
  });

  it("rejects a submission after the deadline before the scheduler sweep", async () => {
    await collecting();
    h.db.prepare("UPDATE games SET submission_deadline = ? WHERE id = ?").run("2026-09-20T12:00:00.000Z", GAME);

    expect(await hostDm(link(videoId("late")))).toMatchObject({ handled: true, kind: "no_collecting_game" });
    expect(count(h.db, "tunes")).toBe(0);
  });

  it("resolve failure DMs the catalog copy, never the raw error", async () => {
    const failing = createHarness({
      deps: {
        resolveTitle: async () => {
          throw new Error("SQLITE_CONSTRAINT: UNIQUE failed for tunes");
        },
      },
    });
    await newGame(failing.deps);
    await accept(failing.deps, "id-alice");

    const r = await handleDm(input("id-host", `<p>${link(videoId("a"))}</p>`), failing.deps);

    // the reason stays available to the caller…
    expect(r).toMatchObject({
      handled: true,
      kind: "tune_rejected",
      detail: "SQLITE_CONSTRAINT: UNIQUE failed for tunes",
    });
    // …but the player only ever sees catalog copy
    const dm = failing.texts().join("\n");
    expect(dm).toContain(m().resolveVideoError());
    expect(dm).not.toContain("SQLITE_CONSTRAINT");
    // …and the internals are still observable to the operator
    expect(failing.deps.logger?.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: "SQLITE_CONSTRAINT: UNIQUE failed for tunes" }),
      "tune submission failed",
    );
  });
});

// ── availability window (v1.1 1.4) ───────────────────────────────

describe("availability window (v1.1 1.4)", () => {
  const DEAD = "dead0000001";
  const available: Partial<HandlerDeps> = { checkAvailable: async (vid: string) => vid !== DEAD };
  const h = useHarness({ deps: available });

  /** ROUND 1 game whose `deadPlayer` has an unplayable round-1 tune. */
  function seedRoundGame(db: Db, deadPlayer: string, names = ["host", "alice"]): string {
    const id = seedTable(db, { currentRound: 1 }, names);
    db.prepare("UPDATE tunes SET video_id = ? WHERE game_id = ? AND account_id = ? AND position = 1").run(
      DEAD,
      id,
      deadPlayer,
    );
    return id;
  }
  const aliceDm = (content: string, extra = {}) =>
    handleDm(input("id-alice", `<p>${content}</p>`, extra), h.deps);
  const pastGrace = () => {
    h.deps.now = () => new Date(new Date(NOW).getTime() + 16 * 60 * 1000);
  };

  it("dead video → round announced, affected player DMed, no poll yet", async () => {
    const gameId = seedRoundGame(h.db, "id-alice");
    await emitRound(h.deps, gameId, 1);

    const round = roundRow(h.db, gameId, 1)!;
    expect(round.status).toBe("announced");
    const meta = JSON.parse(String(round.option_map_json)) as { replacement: { notified: string[] } };
    expect(meta.replacement.notified).toEqual(["id-alice"]);
    expect(h.posts.filter((p) => p.body.visibility === "direct").map((p) => p.body.status!.split(" ")[0])).toEqual([
      "@alice@mastodon.example",
    ]);
  });

  it("replacement arrival via plain link publishes the poll", async () => {
    const gameId = seedRoundGame(h.db, "id-alice");
    await emitRound(h.deps, gameId, 1);

    expect(await aliceDm(link(videoId("fresh")))).toMatchObject({ handled: true, kind: "tune_replaced" });
    expect(roundRow(h.db, gameId, 1)!.status).toBe("poll_open");
  });

  it("routes a replacement to the game whose DM notice was replied to", async () => {
    const first = seedRoundGame(h.db, "id-alice");
    const second = seedRoundGame(h.db, "id-alice");
    await emitRound(h.deps, first, 1);
    await emitRound(h.deps, second, 1);
    const meta = JSON.parse(String(roundRow(h.db, first, 1)!.option_map_json)) as {
      replacement: { prompts: Record<string, string> };
    };

    const result = await aliceDm(link(videoId("scoped")), { inReplyToId: meta.replacement.prompts["id-alice"]! });

    expect(result).toMatchObject({ handled: true, kind: "tune_replaced" });
    expect(roundRow(h.db, first, 1)!.status).toBe("poll_open");
    expect(roundRow(h.db, second, 1)!.status).toBe("announced");
  });

  it("deadline with no replacement → round forfeit excludes the player (2 of 3 → 2-option poll)", async () => {
    const gameId = seedRoundGame(h.db, "id-bob", ["host", "alice", "bob"]);
    await emitRound(h.deps, gameId, 1);
    pastGrace();
    await checkDeadlines(h.sched);

    expect(roundRow(h.db, gameId, 1)!.status).toBe("poll_open");
    expect(pollEntrants(h.db, gameId, 1).sort()).toEqual(["id-alice", "id-host"]);
  });

  it("single remaining player after exclusion → walkover", async () => {
    const gameId = seedRoundGame(h.db, "id-alice");
    await emitRound(h.deps, gameId, 1);
    pastGrace();
    await checkDeadlines(h.sched);

    expect(roundRow(h.db, gameId, 1)).toMatchObject({ status: "walkover", winner_account_id: "id-host" });
  });

  it("`replace <n> <url>` replaces the current round's tune during the window", async () => {
    const gameId = seedRoundGame(h.db, "id-alice");
    await emitRound(h.deps, gameId, 1);
    const fresh = videoId("fresh");

    expect(await aliceDm(`replace 1 https://youtu.be/${fresh}`)).toMatchObject({
      handled: true,
      kind: "tune_replaced",
    });
    expect(tuneAt(h.db, gameId, "id-alice", 1)).toBe(fresh);
    // healthy again → the round publishes
    expect(roundRow(h.db, gameId, 1)!.status).toBe("poll_open");
  });

  it("`replace <n> <url>` targeting another position is rejected while the window is open", async () => {
    const gameId = seedRoundGame(h.db, "id-alice");
    await emitRound(h.deps, gameId, 1);

    expect(await aliceDm(`replace 2 https://youtu.be/${videoId("fresh")}`)).toMatchObject({
      handled: true,
      kind: "replace_rejected",
      detail: "position outside the open window",
    });
    expect(tuneAt(h.db, gameId, "id-alice", 1)).toBe(DEAD);
    expect(h.texts().join("\n")).toContain(m().errReplaceWindowOnly(1));
  });

  it("transient replacement DM failure does not forfeit the game", async () => {
    const fd = createHarness({ deps: available, failDm: new Error("temporary network failure") });
    const gameId = seedRoundGame(fd.db, "id-alice");
    await emitRound(fd.deps, gameId, 1);

    expect(gameRow(fd.db, gameId).status).toBe("ROUND");
    expect(roundRow(fd.db, gameId, 1)!.status).toBe("announced");
  });

  it("unreachable player during the window → FORFEIT, no round published", async () => {
    const fd = createHarness({ deps: available, failDm: new MastodonApiError(403, { error: "account unreachable" }) });
    const gameId = seedRoundGame(fd.db, "id-alice");
    await emitRound(fd.deps, gameId, 1);

    expect(gameRow(fd.db, gameId).status).toBe("FORFEIT");
    // nothing may be published onto the void game — no round row, only the closure notice
    expect(roundRow(fd.db, gameId, 1)).toBeUndefined();
    expect(fd.texts()).toEqual([m().sideForfeit("Theme")]);
  });
});

// ── finale (PRD §5.7/§6) ─────────────────────────────────────────

describe("finale champions (PRD §6)", () => {
  const h = useHarness();

  it("never crowns a withdrawn player in a scoreless finale", async () => {
    const gameId = seedTable(h.db, { status: "FINALE", currentRound: 8 });
    h.db.prepare("UPDATE players SET invite_status = 'declined' WHERE account_id = 'id-alice'").run();

    await emitFinale(h.deps, gameId);

    const text = h.texts().join("\n");
    expect(text).toContain(m().champion("@host"));
    expect(text).not.toContain("@alice");
  });
});

describe("finale playlist link (PRD §5.7)", () => {
  const h = useHarness();
  /** FINALE game "Road Trip": round 1 won by id-host, round 2 by id-alice. */
  function seedFinale(): string {
    const gameId = seedTable(h.db, { status: "FINALE", theme: "Road Trip", currentRound: 8 });
    seedResolvedRounds(h.db, gameId, ["id-host", "id-alice"]);
    return gameId;
  }
  const playlistIdOf = (gameId: string) => gameRow(h.db, gameId).battle_playlist_id;

  it("publishes the battle link as the first finale reply and records the playlist", async () => {
    const publish = vi.fn(async () => ({ url: "https://music.youtube.com/playlist?list=PLx", playlistId: "PLx" }));
    h.deps.publishBattlePlaylist = publish;
    const gameId = seedFinale();

    await emitFinale(h.deps, gameId);

    expect(publish).toHaveBeenCalledWith({
      theme: "Road Trip",
      rounds: 8,
      tunes: [
        { round: 1, videoId: "id-host-1" },
        { round: 2, videoId: "id-alice-2" },
      ],
      existingPlaylistId: null,
    });
    expect(h.posts[1]!.body).toMatchObject({
      in_reply_to_id: "s-1",
      status: expect.stringContaining("https://music.youtube.com/playlist?list=PLx"),
    });
    expect(playlistIdOf(gameId)).toBe("PLx");
  });

  it("reuses the recorded playlist when a finale is emitted again", async () => {
    const publish = vi.fn(async (req: { existingPlaylistId: string | null }) => ({
      url: `https://music.youtube.com/playlist?list=${req.existingPlaylistId}`,
      playlistId: req.existingPlaylistId,
    }));
    h.deps.publishBattlePlaylist = publish;
    const gameId = seedFinale();
    h.db.prepare("UPDATE games SET battle_playlist_id = 'PLrecorded' WHERE id = ?").run(gameId);

    await emitFinale(h.deps, gameId);

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ existingPlaylistId: "PLrecorded" }));
    expect(h.texts()[1]).toContain("list=PLrecorded");
    expect(playlistIdOf(gameId)).toBe("PLrecorded");
  });

  it("posts the finale without a link when nothing could be published", async () => {
    const gameId = seedFinale();

    await emitFinale(h.deps, gameId);

    // summary + one post per winning tune, and no link reply in between
    expect(h.posts).toHaveLength(3);
    expect(h.texts()[1]).toMatch(/Round 1/);
    expect(playlistIdOf(gameId)).toBeNull();
  });
});

// ── cancel command (RULES §4/§6) ─────────────────────────────────

describe("cancel command (RULES §4/§6)", () => {
  const h = useHarness();
  /** "Road Trip" ROUND game, round 1 poll open (status poll-status-1). */
  function seedOpenGame(): string {
    const gameId = seedTable(h.db, { theme: "Road Trip", currentRound: 1 });
    seedPollRound(h.db, gameId, { players: ["id-host", "id-alice"], statusId: "poll-status-1", expiresAt: FUTURE });
    return gameId;
  }
  const cancelFrom = (accountId: string) => handleDm(input(accountId, "<p>cancel</p>"), h.deps);

  it("host cancels mid-round → CANCELLED, poll closed, no champion, notice posted", async () => {
    const gameId = seedOpenGame();

    expect(await cancelFrom("id-host")).toMatchObject({ handled: true, kind: "game_cancelled", detail: gameId });
    expect(gameRow(h.db, gameId).status).toBe("CANCELLED");
    // the live poll is closed and removed — votes cannot land on a void game
    expect(roundRow(h.db, gameId, 1)).toMatchObject({ status: "resolved", poll_status_id: null });
    expect(h.deleted).toEqual(["/api/v1/statuses/poll-status-1"]);
    expect(h.texts()).toContain(m().sideCancelled("Road Trip"));
    expect(h.texts().join("\n")).toContain(m().cancelDone("Road Trip"));
  });

  it("a challenger cannot cancel the host's game", async () => {
    const gameId = seedOpenGame();

    expect(await cancelFrom("id-alice")).toMatchObject({ handled: true, kind: "cancel_rejected" });
    expect(gameRow(h.db, gameId).status).toBe("ROUND");
    expect(h.deleted).toEqual([]);
  });

  it("nothing to cancel → rejected with guidance", async () => {
    expect(await cancelFrom("id-host")).toMatchObject({ handled: true, kind: "cancel_rejected" });
    expect(h.texts().join("\n")).toContain(m().cancelNothing());
  });
});
