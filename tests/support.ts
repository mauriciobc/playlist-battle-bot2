import { afterEach, beforeEach, vi, type Mock } from "vitest";
import { migrate, openDatabase, type Db } from "../src/db/index.js";
import type { CommandInput, HandlerDeps, HandlerResult } from "../src/handlers/deps.js";
import { handlePublicCommand } from "../src/handlers/publicCommand.js";
import { handleDm } from "../src/handlers/directMessage.js";
import { checkPollNotification, type SchedulerDeps } from "../src/scheduler/index.js";
import type { MastodonClient } from "../src/mastodon/client.js";
import type { RawNotification } from "../src/mastodon/notifications.js";
import type { Logger } from "../src/logger.js";

/**
 * Shared fixtures for the handler / scheduler / poller flow specs: a migrated
 * in-memory SQLite, a fake Mastodon client that records everything the bot
 * posts or deletes, and HandlerDeps with deterministic collaborators and a
 * fixed clock (NOW).
 */

export const NOW = "2026-09-21T12:00:00.000Z";
export const PAST = "2026-09-21T11:00:00.000Z";
export const FUTURE = "2026-09-22T12:00:00.000Z";

type PostBody = {
  status?: string;
  visibility?: string;
  in_reply_to_id?: string;
  poll?: { options: string[]; expires_in: number };
};
type Posted = { path: string; body: PostBody };
/** What GET /api/v1/polls/:id answers; option i carries votes[i]. */
type PollState = { expired: boolean; votes: number[] };

type FakeClient = {
  rateLimit: null;
  /** Notification fetches drain `Harness.inbox`; poll fetches answer `Harness.poll`. */
  get: Mock<(path: string) => Promise<unknown>>;
  /** The real client follows Mastodon's Link header (rel="prev"); the fake serves one page. */
  getWithLink: Mock<(path: string) => Promise<{ data: unknown; linkPrev: string | null }>>;
  post: Mock<(path: string, body?: PostBody) => Promise<unknown>>;
  delete: Mock<(path: string) => Promise<unknown>>;
};

type Harness = {
  db: Db;
  posts: Posted[];
  deleted: string[];
  /** Notifications returned (and drained) by the next notification fetch. */
  inbox: RawNotification[];
  /** Mutate in place; the fake client reads it on every poll fetch. */
  readonly poll: PollState;
  client: FakeClient;
  deps: HandlerDeps;
  sched: SchedulerDeps;
  /** Text of every post so far, in order. */
  texts: () => string[];
};

type HarnessOpts = {
  /** Every direct (DM) post rejects with this error. */
  failDm?: Error;
  deps?: Partial<HandlerDeps>;
};

const openDbs: Db[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

export function createHarness(opts: HarnessOpts = {}): Harness {
  const db = openDatabase(":memory:");
  migrate(db);
  openDbs.push(db);
  const posts: Posted[] = [];
  const deleted: string[] = [];
  const inbox: RawNotification[] = [];
  const poll: PollState = { expired: true, votes: [5, 3] };
  const get = vi.fn(async (path: string): Promise<unknown> =>
    path.startsWith("/api/v1/notifications")
      ? inbox.splice(0)
      : { expired: poll.expired, options: poll.votes.map((votes_count, i) => ({ title: `option ${i}`, votes_count })) },
  );
  const client: FakeClient = {
    rateLimit: null,
    get,
    getWithLink: vi.fn(async (path: string) => ({ data: await get(path), linkPrev: null })),
    post: vi.fn(async (path: string, body: PostBody = {}): Promise<unknown> => {
      if (opts.failDm && body.visibility === "direct") throw opts.failDm;
      posts.push({ path, body });
      const id = `s-${posts.length}`;
      return body.poll ? { id, poll: { id: `poll-${posts.length}`, expires_at: FUTURE } } : { id };
    }),
    delete: vi.fn(async (path: string): Promise<unknown> => {
      deleted.push(path);
      return {};
    }),
  };
  let gameSeq = 0;
  const deps: HandlerDeps = {
    db,
    client: client as unknown as MastodonClient,
    botAcct: "playlistbattle",
    instanceDomain: "mastodon.example",
    pollDurationSec: 86400,
    acceptanceWindowSec: 86400,
    submissionWindowSec: 172800,
    creationCooldownSec: 600,
    maxGamesPerPlayer: 3,
    lookup: vi.fn(async (acct: string) => ({ id: `id-${acct.split("@")[0]!}`, acct })),
    resolveTitle: vi.fn(async (videoId: string) => ({
      videoId,
      title: `Title for ${videoId}`,
      author: "Artist",
      canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
    })),
    checkAvailable: vi.fn(async () => true),
    publishBattlePlaylist: vi.fn(async () => null),
    replacementGraceMin: 15,
    now: () => new Date(NOW),
    newGameId: () => `game-${++gameSeq}`,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger,
    ...opts.deps,
  };
  const sched: SchedulerDeps = { handler: deps };
  deps.onPollExpired ??= async (statusId) => {
    await checkPollNotification(sched, statusId);
  };
  return {
    db,
    posts,
    deleted,
    inbox,
    poll,
    client,
    deps,
    sched,
    texts: () => posts.map((p) => p.body.status ?? ""),
  };
}

/** A fresh harness per test (closed automatically after each test). */
export function useHarness(opts: HarnessOpts = {}): Harness {
  const h = {} as Harness;
  beforeEach(() => {
    Object.assign(h, createHarness(opts));
  });
  return h;
}

// ── row access ──────────────────────────────────────────────

type Row = Record<string, unknown>;

export function gameRow(db: Db, gameId: string): Row {
  return db.prepare("SELECT * FROM games WHERE id = ?").get(gameId) as Row;
}

export function roundRow(db: Db, gameId: string, round: number): Row | undefined {
  return db.prepare("SELECT * FROM rounds WHERE game_id = ? AND number = ?").get(gameId, round) as Row | undefined;
}

export function playerRow(db: Db, gameId: string, accountId: string): Row {
  return db.prepare("SELECT * FROM players WHERE game_id = ? AND account_id = ?").get(gameId, accountId) as Row;
}

export function count(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

/** Account ids of a round's poll options (its stored option map). */
export function pollEntrants(db: Db, gameId: string, round: number): string[] {
  return Object.values(JSON.parse(String(roundRow(db, gameId, round)?.option_map_json)) as Record<string, string>);
}

// ── seeding ─────────────────────────────────────────────────

export type SeedGame = {
  id?: string;
  status?: string;
  theme?: string;
  length?: number;
  host?: string;
  acceptanceDeadline?: string;
  submissionDeadline?: string;
  threadRootId?: string;
  currentRound?: number;
  pot?: number;
  pollDurationSec?: number;
  createdAt?: string;
};

let seedSeq = 0;

/** A game row (default: ROUND, theme "Theme", 8 tunes, hosted by host1). */
export function seedGame(db: Db, o: SeedGame = {}): string {
  const id = o.id ?? `g-${++seedSeq}`;
  db.prepare(
    `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec,
      acceptance_deadline, submission_deadline, thread_root_id, current_round, pot, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    o.status ?? "ROUND",
    o.theme ?? "Theme",
    o.length ?? 8,
    o.host ?? "host1",
    o.pollDurationSec ?? 86400,
    o.acceptanceDeadline ?? NOW,
    o.submissionDeadline ?? null,
    o.threadRootId ?? "root-1",
    o.currentRound ?? 0,
    o.pot ?? 0,
    o.createdAt ?? NOW,
    o.createdAt ?? NOW,
  );
  return id;
}

/** A player; role follows the game's host, acct defaults to the account id. */
export function seedPlayer(
  db: Db,
  gameId: string,
  accountId: string,
  o: { acct?: string; invite?: string; points?: number } = {},
): void {
  db.prepare(
    `INSERT INTO players (game_id, account_id, acct, role, invite_status, points)
     VALUES (?, ?, ?, CASE WHEN ? = (SELECT host_account_id FROM games WHERE id = ?) THEN 'host' ELSE 'challenger' END, ?, ?)`,
  ).run(gameId, accountId, o.acct ?? accountId, accountId, gameId, o.invite ?? "accepted", o.points ?? 0);
}

/** Tunes 1..count for a player, video `<accountId>-<pos>` unless overridden. */
export function seedPlaylist(
  db: Db,
  gameId: string,
  accountId: string,
  o: { count?: number; videos?: Record<number, string> } = {},
): void {
  const insert = db.prepare(
    `INSERT INTO tunes (game_id, account_id, position, video_id, title, canonical_url) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  for (let pos = 1; pos <= (o.count ?? 8); pos += 1) {
    const videoId = o.videos?.[pos] ?? `${accountId}-${pos}`;
    insert.run(gameId, accountId, pos, videoId, `Title ${videoId}`, `https://www.youtube.com/watch?v=${videoId}`);
  }
}

/** Two accepted players (host1 hosting, alice) with complete playlists. */
export function seedDuel(db: Db, o: SeedGame & { points?: [number, number] } = {}): string {
  const id = seedGame(db, o);
  const [hostPoints, alicePoints] = o.points ?? [0, 0];
  seedPlayer(db, id, "host1", { points: hostPoints });
  seedPlayer(db, id, "alice", { points: alicePoints });
  seedPlaylist(db, id, "host1");
  seedPlaylist(db, id, "alice");
  return id;
}

/** An open round poll (default: round 1, already expired, host1 vs alice). */
export function seedPollRound(
  db: Db,
  gameId: string,
  o: {
    round?: number;
    expiresAt?: string;
    statusId?: string;
    players?: string[];
    watchedVotes?: number;
    votesChangedAt?: string;
  } = {},
): void {
  const round = o.round ?? 1;
  const optionMap = Object.fromEntries((o.players ?? ["host1", "alice"]).map((p, i) => [String(i), p]));
  db.prepare(
    `INSERT INTO rounds (game_id, number, status, poll_status_id, poll_id, poll_expires_at,
      option_map_json, watched_votes, votes_changed_at)
     VALUES (?, ?, 'poll_open', ?, ?, ?, ?, ?, ?)`,
  ).run(
    gameId,
    round,
    o.statusId ?? "poll-status",
    `pollid-${round}`,
    o.expiresAt ?? PAST,
    JSON.stringify(optionMap),
    o.watchedVotes ?? null,
    o.votesChangedAt ?? null,
  );
}

/** Rounds 1..winners.length already resolved (and posted), won by winners[i]. */
export function seedResolvedRounds(db: Db, gameId: string, winners: string[]): void {
  const insert = db.prepare(
    `INSERT INTO rounds (game_id, number, status, winner_account_id, option_map_json, resolution_posted_at)
     VALUES (?, ?, 'resolved', ?, '{}', ?)`,
  );
  winners.forEach((winner, i) => insert.run(gameId, i + 1, winner, NOW));
}

// ── inbound traffic ─────────────────────────────────────────

let statusSeq = 0;

/** A command from `accountId` (acct = id without the `id-` prefix). */
export function input(accountId: string, content: string, extra: Partial<CommandInput> = {}): CommandInput {
  return {
    accountId,
    accountAcct: accountId.replace(/^id-/, ""),
    statusId: `in-${++statusSeq}`,
    content,
    inReplyToId: null,
    ...extra,
  };
}

/** A deterministic, valid 11-character YouTube video id. */
export function videoId(seed: string, i = 0): string {
  return `${seed.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().padEnd(8, "z")}${String(i).padStart(3, "0")}`.slice(0, 11);
}

export const link = (id: string): string => `https://www.youtube.com/watch?v=${id}`;

/** id-host mentions the bot: `newgame "<theme>" 8 @<challengers>` on status s-create. */
export function newGame(deps: HandlerDeps, challengers = ["alice"], theme = "Theme"): Promise<HandlerResult> {
  const tags = challengers.map((c) => `@${c}`).join(" ");
  return handlePublicCommand(
    input("id-host", `<p>@playlistbattle newgame "${theme}" 8 ${tags}</p>`, { statusId: "s-create" }),
    deps,
  );
}

export async function accept(deps: HandlerDeps, ...accountIds: string[]): Promise<void> {
  for (const id of accountIds) await handleDm(input(id, "<p>accept</p>"), deps);
}

export function mentionNotification(
  id: string,
  content: string,
  o: { accountId?: string; statusId?: string; visibility?: string } = {},
): RawNotification {
  const accountId = o.accountId ?? "id-host";
  const acct = accountId.replace(/^id-/, "");
  return {
    id,
    type: "mention",
    created_at: NOW,
    account: { id: accountId, acct, username: acct },
    status: {
      id: o.statusId ?? `s${id}`,
      visibility: o.visibility ?? "public",
      in_reply_to_id: null,
      content,
      mentions: [{ id: "bot-1", username: "playlistbattle", acct: "playlistbattle" }],
    },
  };
}

export function pollExpiredNotification(id: string, statusId: string): RawNotification {
  return {
    id,
    type: "poll",
    created_at: NOW,
    account: { id: "bot-1", acct: "playlistbattle", username: "playlistbattle" },
    status: { id: statusId, visibility: "public", in_reply_to_id: null, content: "", mentions: [] },
  };
}
