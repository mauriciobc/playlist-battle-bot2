import { describe, expect, it } from "vitest";
import { handlePublicCommand } from "../src/handlers/publicCommand.js";
import { handleDm } from "../src/handlers/directMessage.js";
import { parseDmReply, parseMeritCommand } from "../src/handlers/commands.js";
import { boardText, playerText } from "../src/handlers/meritView.js";
import { m } from "../src/i18n/index.js";
import { POST_LIMIT } from "../src/templates/truncate.js";
import { createHarness, input, seedDuel, seedResolvedRounds, type Harness } from "./support.js";
import { emitFinale } from "../src/scheduler/roundState.js";

/** Close `count` duels the host won, through the real finale path. */
async function playDuels(h: Harness, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const gameId = seedDuel(h.db, { status: "FINALE", theme: "T", length: 8, points: [9, 2] });
    seedResolvedRounds(h.db, gameId, Array.from({ length: 8 }, () => "host1"));
    await emitFinale(h.deps, gameId);
  }
}

const BOARD_TITLE = /🏆 (Ranking|Classificação) · \d{4}-\d{2}-\d{2}/;

describe("merit command parsing", () => {
  it("recognises ranking and badges when the bot is mentioned", () => {
    expect(parseMeritCommand("@playlistbattle ranking", "playlistbattle")).toBe("ranking");
    expect(parseMeritCommand("@playlistbattle badges", "playlistbattle")).toBe("badges");
    expect(parseMeritCommand("@playlistbattle conquistas", "playlistbattle")).toBe("badges");
  });

  it("ignores the commands when the bot is not mentioned", () => {
    expect(parseMeritCommand("just talking about ranking", "playlistbattle")).toBeNull();
  });

  it("ignores a mention of someone else", () => {
    expect(parseMeritCommand("@other ranking", "playlistbattle")).toBeNull();
  });

  it("parses both as DM replies, tolerating the leading mention", () => {
    expect(parseDmReply("ranking")).toEqual({ kind: "ranking" });
    expect(parseDmReply("@bot classificaçao")).toEqual({ kind: "ranking" });
    expect(parseDmReply("conquistas")).toEqual({ kind: "badges" });
  });

  it("does not steal a YouTube link submission", () => {
    expect(parseDmReply("https://www.youtube.com/watch?v=abc12345678").kind).toBe("links");
  });
});

describe("board text", () => {
  it("says the board is empty when no duel has closed", () => {
    const h = createHarness();
    expect(boardText(h.db, new Date(), "wins")).toContain(m().boardEmpty());
    h.db.close();
  });

  it("explains the floor instead of showing a thin board", () => {
    const h = createHarness();
    // One duel each is below the 3-duel floor, so nobody ranks. Dated forward
    // so it is inside the rolling window.
    const gameId = seedDuel(h.db, { status: "FINALE", theme: "T", length: 8, points: [9, 2] });
    seedResolvedRounds(h.db, gameId, Array.from({ length: 8 }, () => "host1"));
    h.db.prepare("INSERT INTO game_results (game_id, theme, closed_at, champion_count, champions_json) VALUES (?, 'T', '2999-01-01T00:00:00.000Z', 1, '[\"host1\"]')").run(gameId);
    h.db.prepare("INSERT INTO game_participants (game_id, account_id, acct, role, points, was_champion) VALUES (?, 'host1', 'host1', 'host', 9, 1)").run(gameId);

    expect(boardText(h.db, new Date(), "wins")).toContain(m().boardFloor());
    h.db.close();
  });

  it("ranks by wins and names the handles", async () => {
    const h = createHarness();
    await playDuels(h, 4);

    const board = boardText(h.db, new Date(), "wins");
    expect(board).toMatch(BOARD_TITLE);
    expect(board).toContain("@host1");
    expect(board).toContain("@alice");
    expect(board).toContain(m().boardWins(4));
    h.db.close();
  });

  it("excludes duels older than the rolling window", async () => {
    const h = createHarness();
    await playDuels(h, 4);
    h.db.prepare("UPDATE game_results SET closed_at = '2000-01-01T00:00:00.000Z'").run();

    expect(boardText(h.db, new Date(), "wins")).toContain(m().boardEmpty());
    h.db.close();
  });

  it("stays inside the post limit with a full board", async () => {
    const h = createHarness();
    await playDuels(h, 5);

    expect(boardText(h.db, new Date(), "wins").length).toBeLessThanOrEqual(POST_LIMIT);
    h.db.close();
  });
});

describe("player text", () => {
  it("invites a stranger to play rather than showing an empty list", () => {
    const h = createHarness();
    expect(playerText(h.db, "nobody", "stranger")).toContain(m().playerNoBadges());
    h.db.close();
  });

  it("lists the badges held above a career line", async () => {
    const h = createHarness();
    await playDuels(h, 3);

    const text = playerText(h.db, "host1", "host1");
    expect(text).toContain("@host1");
    expect(text).toContain(m().badgeName("debut"));
    // Three duels won in a row: the career line reports all three numbers.
    expect(text).toContain(m().playerStats(3, 3, 3));
    expect(text.length).toBeLessThanOrEqual(POST_LIMIT);
    h.db.close();
  });
});

describe("ranking surfaces", () => {
  it("answers a public mention with the board", async () => {
    const h = createHarness();
    await playDuels(h, 4);

    const res = await handlePublicCommand(input("host1", "@playlistbattle ranking"), h.deps);

    expect(res).toMatchObject({ handled: true, kind: "ranking" });
    const text = String(h.posts.at(-1)!.body.status);
    expect(text).toMatch(BOARD_TITLE);
    expect(text).toContain("@host1");
    h.db.close();
  });

  it("answers a DM with the same board", async () => {
    const h = createHarness();
    await playDuels(h, 4);

    const res = await handleDm(input("host1", "ranking"), h.deps);

    expect(res).toMatchObject({ handled: true, kind: "ranking" });
    expect(h.posts.at(-1)!.body).toMatchObject({ visibility: "direct" });
    expect(String(h.posts.at(-1)!.body.status)).toContain("@host1");
    h.db.close();
  });

  it("answers a badges DM with the asker's own record", async () => {
    const h = createHarness();
    await playDuels(h, 2);

    const res = await handleDm(input("alice", "conquistas"), h.deps);

    expect(res).toMatchObject({ handled: true, kind: "badges" });
    expect(String(h.posts.at(-1)!.body.status)).toContain(m().badgeName("debut"));
    h.db.close();
  });

  it("tells an unranked asker so, rather than silently omitting them", async () => {
    const h = createHarness();
    await playDuels(h, 4);

    const res = await handleDm(input("newcomer", "ranking"), h.deps);

    expect(res).toMatchObject({ handled: true, kind: "ranking" });
    expect(String(h.posts.at(-1)!.body.status)).toContain(m().boardUnranked());
    h.db.close();
  });
});

describe("ranking word boundary", () => {
  it("does not treat a longer word as the command", () => {
    expect(parseDmReply("rankings of the 80s").kind).not.toBe("ranking");
    expect(parseDmReply("classificados").kind).not.toBe("ranking");
    expect(parseMeritCommand("@playlistbattle rankings", "playlistbattle")).toBeNull();
    expect(parseDmReply("classificação")).toEqual({ kind: "ranking" });
  });
});
