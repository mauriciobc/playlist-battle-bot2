import { describe, expect, it } from "vitest";
import { pollNotifications } from "../src/mastodon/poller.js";
import { readCursor } from "../src/db/notifications.js";
import { m } from "../src/i18n/index.js";
import {
  count,
  gameRow,
  link,
  mentionNotification,
  playerRow,
  pollEntrants,
  pollExpiredNotification,
  roundRow,
  useHarness,
  videoId,
} from "./support.js";

/**
 * Simulated E2E: full lifecycle through the notification pipeline —
 * create → accept → submit (2 players × 8 tunes) → 8 poll rounds → finale → CLOSED.
 * Mastodon is mocked; handlers, engine, scheduler, poller are real.
 */
describe("simulated full-game E2E", () => {
  const h = useHarness();
  const GAME = "game-1";
  let seq = 1000;
  async function deliver(accountId: string, content: string, visibility = "direct"): Promise<void> {
    seq += 1;
    h.inbox.push(mentionNotification(String(seq), content, { accountId, visibility }));
    await pollNotifications(h.deps);
  }

  it("2 players, 8-length: create → accept → submit → 8 rounds → finale thread → CLOSED", async () => {
    await deliver("id-host", '<p>@playlistbattle newgame "80s Synth" 8 @alice</p>', "public");
    expect(gameRow(h.db, GAME).status).toBe("INVITED");

    await deliver("id-alice", "<p>accept</p>");
    expect(gameRow(h.db, GAME).status).toBe("COLLECTING");

    // both players submit full playlists (one link per line fast path)
    for (const acct of ["host", "alice"]) {
      const links = Array.from({ length: 8 }, (_, i) => link(videoId(acct, i))).join("\n");
      await deliver(`id-${acct}`, `<p>${links}</p>`);
    }
    expect(gameRow(h.db, GAME)).toMatchObject({ status: "ROUND", current_round: 1 });
    expect(count(h.db, "tunes")).toBe(16);

    // round 1 poll: one option per player, configured duration, Mastodon's 25-char option limit
    const poll = h.posts.find((p) => p.body.poll)!.body.poll!;
    expect(poll.options).toHaveLength(2);
    expect(poll.expires_in).toBe(h.deps.pollDurationSec);
    for (const option of poll.options) expect(option.length).toBeLessThanOrEqual(25);

    // drive all 8 rounds via poll-expired notifications; the host wins every poll 5–3
    for (let round = 1; round <= 8; round += 1) {
      const row = roundRow(h.db, GAME, round)!;
      expect(row.status).toBe("poll_open");
      h.poll.votes = pollEntrants(h.db, GAME, round).map((id) => (id === "id-host" ? 5 : 3));
      h.db
        .prepare("UPDATE rounds SET poll_expires_at = '2025-12-31T23:59:59.000Z' WHERE game_id = ? AND number = ?")
        .run(GAME, round);
      seq += 1;
      h.inbox.push(pollExpiredNotification(String(seq), String(row.poll_status_id)));
      await pollNotifications(h.deps);
    }

    expect(gameRow(h.db, GAME)).toMatchObject({ status: "CLOSED", current_round: 8, pot: 0 });
    expect(h.db.prepare("SELECT status, winner_account_id AS winner FROM rounds WHERE game_id = ?").all(GAME)).toEqual(
      Array(8).fill({ status: "resolved", winner: "id-host" }),
    );
    expect(playerRow(h.db, GAME, "id-host").points).toBe(8 * 5);
    expect(playerRow(h.db, GAME, "id-alice").points).toBe(8 * 3);

    // finale: a new root post naming the theme and the champion
    const finale = h.posts.filter((p) => !p.body.in_reply_to_id).at(-1)!.body.status;
    expect(finale).toContain("80s Synth");
    expect(finale).toContain(m().champion("@host"));

    expect(readCursor(h.db).lastId).toBe(String(seq)); // cursor advanced past every notification
  });
});
