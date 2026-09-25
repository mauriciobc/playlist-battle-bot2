/**
 * Console E2E harness — replays real games through the real stack
 * (poller → handlers → engine → scheduler → posts) against a console Mastodon
 * adapter, printing every inbound event, every outbound status, every poll's
 * vote input and result, and a per-scenario DB summary.
 *
 *   npm run e2e:console
 *   npm run e2e:console -- --random [--seed=42]
 *
 * Exits non-zero if any check fails.
 */

import { pathToFileURL } from "node:url";

import { openDatabase, migrate, type Db } from "../src/db/index.js";
import { type HandlerDeps } from "../src/handlers/mention.js";
import { handlePlayerDeleted } from "../src/handlers/closure.js";
import { pollNotifications } from "../src/mastodon/poller.js";
import {
  checkDeadlines,
  checkPollNotification,
  checkPolls,
  type SchedulerDeps,
} from "../src/scheduler/index.js";
import { loadGame, loadPlayers, loadTunes } from "../src/game/store.js";
import { mulberry32 } from "../src/game/shuffle.js";
import type { Game, Player } from "../src/game/types.js";
import type { MastodonClient } from "../src/mastodon/client.js";
import type { RawNotification } from "../src/mastodon/notifications.js";
import { m, setLocale } from "../src/i18n/index.js";
import { createBattlePlaylistPublisher, type BattlePlaylistLink } from "../src/youtube/playlist.js";

// ── constants ───────────────────────────────────────────────

const BOT_ACCT = "playlistbattle";
// Deliberately different from src/config.ts's 900s default: scenarios advance the
// injected clock by a few hours to cross poll expiry, not by minutes per round.
const POLL_DURATION_SEC = 3600;
const ACCEPTANCE_WINDOW_SEC = 86400;
const SUBMISSION_WINDOW_SEC = 172800;
const REPLACEMENT_GRACE_MIN = 15;
const CLOCK_BASE = "2026-01-01T00:00:00.000Z";
const PLAYLIST_LENGTH = 8;
/** Independent of src's ROUND_QUORUM so the ledger stays a real cross-check. */
const QUORUM = 3;

/**
 * YouTube's `watch_videos` queue endpoint without the network: the harness must
 * not depend on youtube.com being reachable (or on how fast it answers), so the
 * endpoint answers like the real 303 redirect with a fixed list token.
 */
const queueFetch: typeof fetch = async (input) => {
  const ids = new URL(String(input)).searchParams.get("video_ids")?.split(",") ?? [];
  const first = ids[0] ?? "";
  return new Response(null, {
    status: 303,
    headers: { location: `https://www.youtube.com/watch?v=${first}&list=TLGGconsole0000000` },
  });
};

// ── CLI ─────────────────────────────────────────────────────

type CliArgs = { random: boolean; seed: number };

function usage(problem: string): never {
  console.error(`e2e-console: ${problem}`);
  console.error("usage: tsx scripts/e2e-console.ts [--random] [--seed=<int>]");
  process.exit(2);
}

function parseArgs(argv: string[]): CliArgs {
  let random = false;
  let seed: number | null = null;
  for (const arg of argv) {
    if (arg === "--random") {
      random = true;
    } else if (arg.startsWith("--seed=")) {
      const raw = arg.slice("--seed=".length);
      const value = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(value)) usage(`invalid --seed value: ${raw}`);
      seed = Math.trunc(value);
    } else {
      usage(`unknown argument: ${arg}`);
    }
  }
  return { random, seed: seed ?? (random ? Date.now() % 2 ** 31 : 0) };
}

// ── types ───────────────────────────────────────────────────

/** Per-poll vote vector keyed by player handle; null = RNG fuzz. */
type Votes = Record<string, number>[] | null;
type PollRecord = { pollId: string; statusId: string; options: string[]; votes: number[] };
type ConsolePost = { id: string; body: Record<string, unknown> };
type Check = { label: string; ok: boolean; detail: string | undefined };

type RoundRow = {
  number: number;
  status: string;
  winner_account_id: string | null;
  option_map_json: string;
  poll_status_id: string | null;
};

type RoundResult = {
  /** `void`: closed unscored because the game itself was voided (FORFEIT). */
  kind: "poll" | "auto_tie" | "walkover" | "void";
  winner: string | null;
  potAwarded: number;
};

function videoIds(acct: string): string[] {
  const base = acct.replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(8, "0");
  return Array.from({ length: PLAYLIST_LENGTH }, (_, i) => `${base}${String(i + 1).padStart(3, "0")}`.slice(0, 11));
}

// ── harness ─────────────────────────────────────────────────

/**
 * Empty every user table, leaving the schema (and the connection's compiled
 * statements and page cache) in place. Foreign keys are suspended for the
 * duration: rows are dropped table by table, not in dependency order. The
 * notification cursor is seeded by the migration as a row, so it is reset
 * rather than removed.
 */
function wipe(db: Db): void {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         AND name NOT IN ('schema_migrations', 'cursor')`,
    )
    .all() as { name: string }[];
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      for (const { name } of tables) db.prepare(`DELETE FROM "${name}"`).run();
      db.prepare("UPDATE cursor SET last_notification_id = '' WHERE id = 1").run();
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

export class Harness {
  readonly db: Db;
  readonly checks: Check[] = [];
  gameId: string | null = null;

  /** False when the harness borrowed a connection and must not close it. */
  private readonly ownsDb: boolean;
  private readonly deps: HandlerDeps;
  private readonly schedDeps: SchedulerDeps;
  private readonly posts: ConsolePost[] = [];
  private readonly polls: PollRecord[] = [];
  private readonly queue: RawNotification[] = [];
  private readonly deadVideos = new Set<string>();
  private readonly ledger = {
    pot: 0,
    points: new Map<string, number>(),
    finalSplit: null as { total: number; each: number; count: number } | null,
    appliedRounds: new Set<number>(),
    winners: 0,
  };
  private readonly rng: () => number;
  /** What the finale's playlist publisher returned, so the checks can assert on it. */
  private playlistLink: BattlePlaylistLink | null = null;
  private clock = new Date(CLOCK_BASE);
  private notifSeq = 0;
  private postSeq = 0;
  private voteCursor = 0;

  /**
   * A scenario needs a database with no trace of the previous one. Creating a
   * fresh `:memory:` connection per scenario is one way; the benchmark passes a
   * shared `connection` instead, because a real bot runs one long-lived
   * connection — SQLite would otherwise recompile every statement and start
   * with a cold page cache, which is a property of the harness, not the bot.
   * Wiping the tables gives the same clean slate on a warm connection.
   */
  constructor(
    private readonly votes: Votes,
    seed: number,
    private readonly expectedStatuses: string[],
    connection?: Db,
  ) {
    this.rng = mulberry32(seed);
    this.ownsDb = connection === undefined;
    this.db = connection ?? openDatabase(":memory:");
    if (this.ownsDb) migrate(this.db);
    else wipe(this.db);

    const get = async (path: string) => {
      if (path.startsWith("/api/v1/notifications")) return this.queue.splice(0);
      if (path.startsWith("/api/v1/polls/")) {
        const pollId = path.slice("/api/v1/polls/".length);
        const record = this.polls.find((p) => p.pollId === pollId);
        if (!record) throw new Error(`console client: unknown poll ${pollId}`);
        const parts = record.options.map((title, i) => `${i}) ${title} = ${record.votes[i] ?? 0}`);
        console.log(`[VOTE] ${record.pollId} · ${parts.join(" · ")}`);
        console.log();
        return {
          expired: true,
          options: record.options.map((title, i) => ({ title, votes_count: record.votes[i] ?? 0 })),
        };
      }
      throw new Error(`console client: unexpected GET ${path}`);
    };
    const client = {
      get,
      // The real client follows Mastodon's Link header; the console serves one page.
      getWithLink: async (path: string) => ({ data: await get(path), linkNext: null }),
      post: async (path: string, body?: unknown) => {
        if (path !== "/api/v1/statuses") throw new Error(`console client: unexpected POST ${path}`);
        const payload = (body ?? {}) as Record<string, unknown>;
        const n = (this.postSeq += 1);
        const id = `s-${n}`;
        const poll = payload.poll as { options: string[]; expires_in: number } | undefined;
        this.posts.push({ id, body: payload });
        this.printPost(id, payload);
        if (!poll) return { id };
        const pollId = `poll-${n}`;
        this.polls.push({ pollId, statusId: id, options: poll.options, votes: this.nextVotes(poll.options) });
        const expiresAt = new Date(this.clock.getTime() + poll.expires_in * 1000).toISOString();
        return { id, poll: { id: pollId, expires_at: expiresAt } };
      },
      delete: async (path: string) => {
        const prefix = "/api/v1/statuses/";
        if (!path.startsWith(prefix)) throw new Error(`console client: unexpected DELETE ${path}`);
        const statusId = path.slice(prefix.length);
        const pollIndex = this.polls.findIndex((p) => p.statusId === statusId);
        const poll = pollIndex >= 0 ? this.polls.splice(pollIndex, 1)[0] : undefined;
        const postIndex = this.posts.findIndex((p) => p.id === statusId);
        if (postIndex >= 0) this.posts.splice(postIndex, 1);
        console.log(`[DEL ] status ${statusId} removed${poll ? ` (poll ${poll.pollId})` : ""}`);
        console.log();
        return {};
      },
    };

    const publishBattlePlaylist = createBattlePlaylistPublisher({ fetchImpl: queueFetch });
    this.deps = {
      db: this.db,
      client: client as unknown as MastodonClient,
      botAcct: BOT_ACCT,
      instanceDomain: "mastodon.example",
      pollDurationSec: POLL_DURATION_SEC,
      acceptanceWindowSec: ACCEPTANCE_WINDOW_SEC,
      submissionWindowSec: SUBMISSION_WINDOW_SEC,
      creationCooldownSec: 600,
      maxGamesPerPlayer: 3,
      lookup: async (acct) => ({ id: `id-${acct}`, acct }),
      resolveTitle: async (videoId) => ({
        videoId,
        title: `Track ${videoId}`,
        author: "Artist",
        canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      }),
      checkAvailable: async (videoId) => !this.deadVideos.has(videoId),
      // Anonymous queue links only: the console harness never touches an account.
      // The link is recorded so the finale checks can assert on the replies.
      publishBattlePlaylist: async (input) => {
        const link = await publishBattlePlaylist(input);
        this.playlistLink = link;
        return link;
      },
      replacementGraceMin: REPLACEMENT_GRACE_MIN,
      now: () => this.clock,
      newGameId: () => "g-1",
      // Same wiring as src/index.ts, so the poll-notification fast path is real.
      onPollExpired: async (statusId) => {
        await checkPollNotification(this.schedDeps, statusId);
      },
    };
    this.schedDeps = { handler: this.deps };
  }

  /** Close the harness's own connection; a borrowed one stays open. */
  close(): void {
    if (this.ownsDb) this.db.close();
  }

  // ── driving (every action reconciles: one can cascade through the finale) ──

  advanceSec(sec: number): void {
    this.clock = new Date(this.clock.getTime() + sec * 1000);
    console.log(`[CLOCK] +${sec}s → ${this.clock.toISOString()}`);
  }

  async say(acct: string, content: string, visibility: "public" | "direct" = "public"): Promise<void> {
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    const desc = lines.length > 0 && lines.every((l) => /^https?:\/\//.test(l.trim()))
      ? `${lines.length} links`
      : `${lines[0] ?? content}${lines.length > 1 ? ` · (+${lines.length - 1} more lines)` : ""}`;
    console.log(`[IN  ] @${acct} · ${visibility} · ${desc}`);
    console.log();
    await this.deliver((seq) => ({
      type: "mention",
      account: { id: `id-${acct}`, acct, username: acct },
      status: {
        id: `s-in-${seq}`,
        visibility,
        in_reply_to_id: null,
        content: `<p>${content.replace(/\n/g, "<br />")}</p>`,
        mentions: [{ id: "bot-1", username: BOT_ACCT, acct: BOT_ACCT }],
      },
    }));
  }

  /** Host "host" invites `challengers`; those in `accept` accept by DM. */
  async newGame(theme: string, challengers: string[], accept = challengers): Promise<void> {
    const mentions = challengers.map((c) => `@${c}`).join(" ");
    await this.say("host", `@${BOT_ACCT} newgame "${theme}" ${PLAYLIST_LENGTH} ${mentions}`);
    for (const acct of accept) await this.say(acct, "accept", "direct");
    const row = this.db.prepare("SELECT id FROM games").get() as { id: string } | undefined;
    if (!row) throw new Error("harness: no game row");
    this.gameId = row.id;
  }

  async submit(acct: string, ids = videoIds(acct)): Promise<void> {
    await this.say(acct, ids.map((v) => `https://www.youtube.com/watch?v=${v}`).join("\n"), "direct");
  }

  async expireRound(round: number): Promise<void> {
    const statusId = this.rounds().find((r) => r.number === round)?.poll_status_id;
    if (!statusId) throw new Error(`harness: round ${round} has no poll`);
    this.db
      .prepare("UPDATE rounds SET poll_expires_at = ? WHERE poll_status_id = ?")
      .run(new Date(this.clock.getTime() - 1).toISOString(), statusId);
    console.log(`[IN  ] poll expired · ${statusId}`);
    await this.deliver(() => ({
      type: "poll",
      account: { id: "bot-1", acct: BOT_ACCT, username: BOT_ACCT },
      status: { id: statusId, visibility: "public", in_reply_to_id: null, content: "", mentions: [] },
    }));
  }

  async sweep(kind: "polls" | "deadlines"): Promise<void> {
    console.log(`[SWEEP] ${kind === "polls" ? "checkPolls" : "checkDeadlines"}`);
    await (kind === "polls" ? checkPolls : checkDeadlines)(this.schedDeps);
    this.reconcile();
  }

  async playerDeleted(accountId: string): Promise<void> {
    console.log(`[EVNT] player deleted · ${accountId}`);
    await handlePlayerDeleted(this.deps, accountId);
    this.reconcile();
  }

  markVideoDead(videoId: string): void {
    console.log(`[EVNT] video unavailable · ${videoId}`);
    this.deadVideos.add(videoId);
  }

  private async deliver(
    build: (seq: number) => Pick<RawNotification, "type" | "account" | "status">,
  ): Promise<void> {
    const seq = (this.notifSeq += 1);
    this.queue.push({ id: String(1000 + seq), created_at: this.clock.toISOString(), ...build(seq) });
    await pollNotifications(this.deps);
    if (this.queue.length > 0) {
      throw new Error(
        `console client: ${this.queue.length} queued notification(s) were not consumed by pollNotifications`,
      );
    }
    this.reconcile();
  }

  /** Poll votes are decided at poll-creation time: scripted vector, or RNG fuzz. */
  private nextVotes(options: string[]): number[] {
    if (!this.votes) return options.map(() => Math.floor(this.rng() * 7));
    const spec = this.votes[this.voteCursor];
    const poll = `scripted votes: poll #${(this.voteCursor += 1)}`;
    if (!spec) throw new Error(`${poll} has no vector (scenario declared ${this.votes.length})`);
    const handles = Object.keys(spec);
    if (handles.length !== options.length) {
      throw new Error(`${poll} has ${options.length} options but its vector names ${handles.length} players`);
    }
    return options.map((option, index) => {
      const handle = handles.find((h) => option.startsWith(`${h}: `));
      if (!handle) throw new Error(`${poll} option ${index} ("${option}") matches none of ${handles.join(", ")}`);
      return spec[handle]!;
    });
  }

  private printPost(id: string, payload: Record<string, unknown>): void {
    const status = String(payload.status ?? "");
    const visibility = String(payload.visibility ?? "public");
    const inReplyTo = payload.in_reply_to_id as string | undefined;
    const poll = payload.poll as { options: string[]; expires_in: number; multiple: boolean } | undefined;

    let meta = `[OUT ] ${id} · ${visibility} · ${inReplyTo ? `reply→${inReplyTo}` : "(root)"}`;
    if (poll) meta += " · POLL";
    if (visibility === "direct") {
      const handle = status.match(/@([A-Za-z0-9_]+)/);
      if (handle?.[1]) meta += ` · DM→@${handle[1]}`;
    }
    console.log(meta);
    for (const line of status.split("\n")) console.log(`      │ ${line}`);
    if (poll) {
      console.log(`      │ options (expires_in ${poll.expires_in}s, multiple=${poll.multiple}):`);
      poll.options.forEach((option, i) => console.log(`      │   ${i}) ${option}`));
    }
    console.log();
  }

  check(label: string, ok: boolean, detail?: string): void {
    this.checks.push({ label, ok, detail });
    if (!ok) console.log(`❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }

  // ── DB helpers ────────────────────────────────────────────

  private game(): string {
    if (!this.gameId) throw new Error("harness: no game created");
    return this.gameId;
  }

  rounds(): RoundRow[] {
    return this.db
      .prepare(
        `SELECT number, status, winner_account_id, option_map_json, poll_status_id
         FROM rounds WHERE game_id = ? ORDER BY number`,
      )
      .all(this.game()) as RoundRow[];
  }

  /** Public root statuses posted so far — a finale is the only root a game posts. */
  rootPosts(): ConsolePost[] {
    return this.posts.filter((p) => !p.body.in_reply_to_id && p.body.visibility === "public");
  }

  // ── ledger / reconciliation ───────────────────────────────

  private award(accountId: string, amount: number): void {
    this.ledger.points.set(accountId, (this.ledger.points.get(accountId) ?? 0) + amount);
  }

  /** Final-round tie: split the PRE-round pot evenly (no growth), remainder dropped. */
  private splitFinalPot(tiedIds: string[]): void {
    const count = tiedIds.length;
    const each = count > 0 ? Math.floor(this.ledger.pot / count) : 0;
    const total = each * count;
    for (const id of tiedIds) this.award(id, each);
    this.ledger.finalSplit = total > 0 ? { total, each, count } : null;
    this.ledger.pot = 0;
  }

  /**
   * Independent model of the PRD scoring rules, fed only by the votes the
   * harness injected — never by engine internals. Mirrors
   * resolveRoundScore (quorum) + resolveRound (final split of the PRE-round
   * pot, no growth on a final tie).
   */
  private applyRound(game: Game, row: RoundRow): RoundResult {
    const isFinal = row.number >= game.playlistLength;
    const pot = this.ledger.pot;

    if (row.status === "resolved" && row.poll_status_id === null && row.winner_account_id === null) {
      // Round closed without being scored: the game was voided (a deleted or
      // unreachable player closes any open poll). No votes, no pot movement.
      return { kind: "void", winner: null, potAwarded: 0 };
    }

    if (row.status === "auto_tied") {
      // v1.1 1.3 final auto-tie: split the pre-round pot among all round
      // participants (no poll ran, so everyone is tied). No pot growth.
      if (isFinal) this.splitFinalPot(this.roundParticipants(game.id, row.number));
      else this.ledger.pot += 1;
      return { kind: "auto_tie", winner: null, potAwarded: 0 };
    }

    let kind: RoundResult["kind"];
    let winner: string | null;
    if (row.status === "walkover") {
      kind = "walkover";
      winner = row.winner_account_id;
    } else {
      kind = "poll";
      const record = this.polls.find((p) => p.statusId === row.poll_status_id);
      if (!record) {
        this.check(`R${row.number} votes recorded`, false, `no poll record for ${row.poll_status_id}`);
        this.ledger.pot += 1;
        return { kind, winner: null, potAwarded: 0 };
      }
      const optionMap = JSON.parse(row.option_map_json) as Record<string, string>;
      const tallies = new Map<string, number>();
      record.options.forEach((_title, i) => {
        const accountId = optionMap[String(i)];
        if (accountId) tallies.set(accountId, (tallies.get(accountId) ?? 0) + (record.votes[i] ?? 0));
      });
      for (const [accountId, votes] of tallies) this.award(accountId, votes);
      const top = Math.max(0, ...tallies.values());
      const leaders = [...tallies.keys()].filter((id) => tallies.get(id) === top);
      const totalVotes = [...tallies.values()].reduce((s, v) => s + v, 0);
      // v1.1 1.2 quorum: fewer than QUORUM total votes → always a tie.
      winner = leaders.length === 1 && top > 0 && totalVotes >= QUORUM ? leaders[0]! : null;
      if (!winner) {
        // v1.1 1.3: final-round tie splits the PRE-round pot (no growth).
        // Quorum-forced tie with a unique leader → all participants share.
        if (isFinal) this.splitFinalPot(leaders.length === 1 ? [...tallies.keys()] : leaders);
        else this.ledger.pot += 1;
      }
    }

    if (!winner) return { kind, winner: null, potAwarded: 0 };
    this.award(winner, pot);
    this.ledger.pot = 0;
    this.ledger.winners += 1;
    return { kind, winner, potAwarded: pot };
  }

  /** Participants holding a tune at (game, round): mirrors eligibleForRound. */
  private roundParticipants(gameId: string, round: number): string[] {
    const hasTune = new Set(
      loadTunes(this.db, gameId).filter((t) => t.position === round).map((t) => t.accountId),
    );
    return loadPlayers(this.db, gameId)
      .filter((p) => p.inviteStatus === "accepted" && hasTune.has(p.accountId))
      .map((p) => p.accountId);
  }

  /**
   * Walk every round not yet modelled, ascending, applying the ledger rule and
   * checking the DB against it; pot and points are compared once no round is open.
   */
  reconcile(): void {
    const gameId = this.gameId;
    if (!gameId) return;
    const game = loadGame(this.db, gameId);
    if (!game) {
      this.check(`game ${gameId} readable`, false, "game row missing");
      return;
    }
    const rows = this.rounds();
    const players = loadPlayers(this.db, gameId);
    const terminal = (status: string) => status === "resolved" || status === "auto_tied" || status === "walkover";
    const pending = rows.filter((r) => terminal(r.status) && !this.ledger.appliedRounds.has(r.number));
    const settled = rows.every((r) => terminal(r.status));

    for (const [index, row] of pending.entries()) {
      const result = this.applyRound(game, row);
      this.ledger.appliedRounds.add(row.number);
      const firstCheck = this.checks.length;
      const r = `R${row.number}`;
      const expected = this.expectedStatuses[row.number - 1];
      if (expected !== undefined) {
        this.check(`${r} status`, row.status === expected, `db ${row.status} vs expected ${expected}`);
      }
      if (result.kind === "poll") {
        this.check(
          `${r} winner`,
          result.winner === row.winner_account_id,
          `db ${row.winner_account_id ?? "null"} vs ledger ${result.winner ?? "null"}`,
        );
      }
      if (settled && index === pending.length - 1) {
        this.check(`${r} pot`, game.pot === this.ledger.pot, `db ${game.pot} vs ledger ${this.ledger.pot}`);
        for (const p of players) {
          const want = this.ledger.points.get(p.accountId) ?? 0;
          this.check(`${r} points @${p.acct}`, p.points === want, `db ${p.points} vs ledger ${want}`);
        }
      }
      this.printResult(row, result, players, this.checks.slice(firstCheck).filter((c) => !c.ok));
    }
  }

  private printResult(row: RoundRow, result: RoundResult, players: Player[], failures: Check[]): void {
    const who = result.winner
      ? `@${players.find((p) => p.accountId === result.winner)?.acct ?? result.winner}`
      : null;
    const desc = {
      void: "void (game closed unscored)",
      auto_tie: "auto-tie",
      walkover: who ? `walkover ${who}` : "walkover (no eligible player)",
      poll: who ? `winner ${who}` : "tie",
    }[result.kind];
    const points = players
      .map((p) => ({ acct: p.acct, points: this.ledger.points.get(p.accountId) ?? 0 }))
      .sort((a, b) => b.points - a.points || a.acct.localeCompare(b.acct))
      .map((e) => `@${e.acct} ${e.points}`)
      .join(" · ");
    const verdict = failures.length === 0 ? "✓" : `✗ ${failures.map((c) => c.detail ?? c.label).join("; ")}`;
    console.log(
      `[RSLT] R${row.number} · ${desc} · pot awarded ${result.potAwarded} · points ${points} · pot ${this.ledger.pot} · ${verdict}`,
    );
    console.log();
  }

  // ── scenario assertions ───────────────────────────────────

  expectTerminal(expected: string, sideEffectPost?: string): void {
    const game = loadGame(this.db, this.game());
    this.check(`game status is ${expected}`, game?.status === expected, `actual ${game?.status ?? "missing"}`);
    if (expected === "CLOSED") {
      this.check("pot is 0 after CLOSED", (game?.pot ?? -1) === 0, `pot ${game?.pot}`);
    }
    if (sideEffectPost !== undefined) {
      const found = this.posts.some((p) => String(p.body.status ?? "") === sideEffectPost);
      this.check("side-effect post", found, sideEffectPost);
    }
  }

  expectPollCount(expected: number): void {
    const actual = this.rounds().filter((r) => r.poll_status_id !== null).length;
    this.check(`poll count is ${expected}`, actual === expected, `actual ${actual}`);
  }

  expectStatusVector(): void {
    const actual = this.rounds().map((r) => r.status).join(",");
    const expected = this.expectedStatuses.join(",");
    this.check("round status vector", actual === expected, `actual ${actual} vs expected ${expected}`);
  }

  /** A game voided mid-duel closes its live round-1 poll and deletes the poll status. */
  expectLivePollClosed(): void {
    const r1 = this.rounds()[0];
    this.check(
      "R1 poll closed",
      r1?.status === "resolved" && r1.poll_status_id === null,
      `actual ${r1?.status}/${r1?.poll_status_id ?? "null"}`,
    );
    this.expectPollCount(0);
  }

  /**
   * Locale-independent probe for the final-split line: the catalog line with its
   * numbers blanked, so a copy edit cannot make the absence check vacuous.
   */
  private splitLineProbe(): RegExp {
    const sentinel = 424242;
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = m().finalePotSplit(sentinel, sentinel, sentinel).split(String(sentinel)).map(escape);
    return new RegExp(parts.join("\\d+"));
  }

  /** Finale summary checks — all derived from the ledger, never hardcoded. */
  expectFinale(): void {
    const all = loadPlayers(this.db, this.game());
    // Mirrors emitFinale: only players who actually dueled can be crowned.
    const duelers = all.filter((p) => p.inviteStatus === "accepted");
    const pointsOf = (p: Player) => this.ledger.points.get(p.accountId) ?? 0;
    const top = Math.max(0, ...duelers.map(pointsOf));
    const champions = duelers.filter((p) => pointsOf(p) === top).map((p) => p.acct);

    const summary = this.rootPosts().at(-1);
    this.check(
      "finale summary posted as a root status",
      Boolean(summary),
      summary ? undefined : "no root public status found",
    );
    if (!summary) return;

    const text = String(summary.body.status ?? "");
    const flat = text.replace(/\n/g, " | ");
    for (const acct of champions) {
      this.check(`finale names @${acct}`, text.includes(`@${acct}`), text.split("\n")[0] ?? "");
    }
    for (const p of all.filter((p) => p.inviteStatus !== "accepted")) {
      this.check(`finale never crowns withdrawn @${p.acct}`, !text.includes(`@${p.acct}`), flat);
    }
    // The finale replies with the battle link first (only when publishing
    // worked), then one reply per winning round.
    const link = this.playlistLink;
    const replies = this.posts.filter((p) => p.body.in_reply_to_id === summary.id);
    const expectedReplies = this.ledger.winners + (link ? 1 : 0);
    this.check(
      "finale tune replies match ledger winners",
      replies.length === expectedReplies,
      `${replies.length} replies vs ${expectedReplies} expected for ${this.ledger.winners} winning rounds`,
    );
    if (link) {
      const queueReply = replies.find((p) => String(p.body.status ?? "").includes(link.url));
      this.check("finale queue reply carries the published link", Boolean(queueReply), link.url);
    }
    const split = this.ledger.finalSplit;
    if (split) {
      this.check(
        `finale reports pot split ${split.total} → ${split.each}×${split.count}`,
        text.includes(m().finalePotSplit(split.total, split.each, split.count)),
        flat,
      );
    } else {
      this.check("finale has no split line", !this.splitLineProbe().test(text), flat);
    }
  }

  // ── footer ────────────────────────────────────────────────

  finish(label: string): number {
    const game = this.gameId ? loadGame(this.db, this.gameId) : null;
    if (game) {
      const players = loadPlayers(this.db, game.id);
      const rounds = this.rounds().map((r) => `R${r.number} ${r.status}(${this.winnerLabel(r, players)})`);
      console.log("── state ───────────────────────────────────────────────────────────");
      console.log(
        `game ${game.id} · ${game.status} · pot ${game.pot} · round ${game.currentRound} · theme "${game.theme}"`,
      );
      console.log(`rounds  ${rounds.join(" · ") || "—"}`);
      console.log(`points  ${players.map((p) => `@${p.acct} ${p.points}`).join(" · ")}`);
      console.log(`posts   ${this.posts.length} statuses · ${this.polls.length} polls`);
    }
    const failed = this.checks.filter((c) => !c.ok).length;
    console.log("── checks ──────────────────────────────────────────────────────────");
    for (const c of this.checks) {
      console.log(`${c.ok ? "✅" : "❌"} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
    }
    console.log(`scenario ${label}: ${failed === 0 ? "PASS" : "FAIL"} (${this.checks.length} checks)`);
    console.log();
    return failed;
  }

  private winnerLabel(row: RoundRow, players: Player[]): string {
    if (row.winner_account_id) {
      return players.find((p) => p.accountId === row.winner_account_id)?.acct ?? row.winner_account_id;
    }
    if (row.status === "walkover") return "none";
    if (row.status === "resolved") return row.poll_status_id === null ? "void" : "tie";
    if (row.status === "auto_tied") return "tie";
    return "open";
  }
}

// ── scenarios ───────────────────────────────────────────────

export type Scenario = {
  label: string;
  title: string;
  votes: Votes;
  expectedStatuses?: string[];
  run: (h: Harness) => Promise<void>;
};

const ALL_RESOLVED = Array.from({ length: PLAYLIST_LENGTH }, () => "resolved");

export const SCENARIOS: Scenario[] = [
  {
    label: "A",
    title: "SCENARIO A — 2 players · 8 rounds · wins, ties, pot carry, split final pot",
    votes: [
      { host: 5, alice: 3 }, // R1 clear win, empty pot
      { host: 2, alice: 2 }, // R2 2-way tie → pot 1
      { host: 4, alice: 0 }, // R3 win takes pot
      { host: 0, alice: 0 }, // R4 all-zero tie → pot 1
      { host: 1, alice: 3 }, // R5 win takes pot
      { host: 6, alice: 1 }, // R6 clear win, empty pot
      { host: 0, alice: 3 }, // R7 win with zero pot (quorum-safe: 3 total votes)
      { host: 3, alice: 3 }, // R8 final tie → split pre-round pot
    ],
    expectedStatuses: ALL_RESOLVED,
    run: async (h) => {
      await h.newGame("80s Synth", ["alice"]);
      await h.submit("host");
      await h.submit("alice");
      // R1 resolves through the periodic sweep; R2–R8 through poll notifications.
      h.advanceSec(POLL_DURATION_SEC + 1);
      await h.sweep("polls");
      for (let round = 2; round <= 8; round += 1) await h.expireRound(round);
      h.expectTerminal("CLOSED");
      h.expectPollCount(8);
      h.expectFinale();
    },
  },
  {
    label: "B",
    title: "SCENARIO B — 3 players · multi-way ties + final split + shared championship",
    votes: [
      { host: 2, bob: 2, carol: 2 }, // R1 3-way tie → pot 1
      { host: 5, bob: 1, carol: 0 }, // R2 win takes pot
      { host: 0, bob: 4, carol: 4 }, // R3 2-way tie → pot 1
      { host: 3, bob: 0, carol: 3 }, // R4 2-way tie → pot 2
      { host: 0, bob: 0, carol: 0 }, // R5 all-zero tie → pot 3
      { host: 3, bob: 3, carol: 1 }, // R6 2-way tie → pot 4 (builds the final split)
      { host: 4, bob: 0, carol: 4 }, // R7 2-way tie → pot 5
      { host: 2, bob: 2, carol: 0 }, // R8 final tie → split pre-round pot
    ],
    expectedStatuses: ALL_RESOLVED,
    run: async (h) => {
      await h.newGame("Guilty Pleasures", ["bob", "carol"]);
      for (const acct of ["host", "bob", "carol"]) await h.submit(acct);
      for (let round = 1; round <= 8; round += 1) await h.expireRound(round);
      h.expectTerminal("CLOSED");
      h.expectPollCount(8);
      h.expectFinale();
    },
  },
  {
    label: "C",
    title: "SCENARIO C — auto-tie + unavailable video · round forfeit · walkover",
    votes: [
      { host: 5, alice: 3 }, // R1 host wins, pot 0
      { host: 1, alice: 4 }, // R3 alice wins, pot 0
      { host: 4, alice: 2 }, // R4 host wins, pot 0
      { host: 3, alice: 1 }, // R6 host wins, pot 0
      { host: 2, alice: 4 }, // R7 alice wins, pot 0
      { host: 3, alice: 1 }, // R8 host wins, takes pot 0
    ],
    expectedStatuses: ["resolved", "auto_tied", "resolved", "resolved", "walkover", "resolved", "resolved", "resolved"],
    run: async (h) => {
      await h.newGame("One-Hit Wonders", ["alice"]);
      // Cross-player duplicate at position 2 → automatic tie, no poll for round 2.
      const hostTunes = videoIds("host");
      const aliceTunes = videoIds("alice");
      hostTunes[1] = aliceTunes[1] = "dup00000001";
      await h.submit("host", hostTunes);
      await h.submit("alice", aliceTunes);
      await h.expireRound(1); // R2 auto-ties during the same action
      await h.expireRound(3);

      // v1.1 1.4: alice's round-5 tune dies before round 5 is emitted (round 5
      // emits as a side effect of resolving round 4). No replacement arrives, so
      // round 5 is a walkover for the host; rounds 6+ resume as normal polls.
      h.markVideoDead(aliceTunes[4]!);
      await h.expireRound(4);
      const r5 = h.rounds().find((r) => r.number === 5);
      h.check("R5 waits on replacement window", r5?.status === "announced", `actual ${r5?.status ?? "missing"}`);

      h.advanceSec(REPLACEMENT_GRACE_MIN * 60 + 1);
      await h.sweep("deadlines"); // R5 walkover; R6 poll opens
      for (const round of [6, 7, 8]) await h.expireRound(round);

      h.expectTerminal("CLOSED");
      h.expectPollCount(6);
      h.expectStatusVector();
      h.expectFinale();
    },
  },
  {
    label: "D1",
    title: "SCENARIO D1 — invitation never accepted → EXPIRED",
    votes: [],
    run: async (h) => {
      await h.newGame("Ghost Town", ["alice"], []);
      h.advanceSec(ACCEPTANCE_WINDOW_SEC + 86400);
      await h.sweep("deadlines");
      h.expectTerminal("EXPIRED", m().sideExpired("Ghost Town"));
      h.expectPollCount(0);
    },
  },
  {
    label: "D2",
    title: "SCENARIO D2 — accepted, nobody submits → FIZZLED",
    votes: [],
    run: async (h) => {
      await h.newGame("Silent Disco", ["alice"]);
      h.advanceSec(SUBMISSION_WINDOW_SEC + 86400);
      await h.sweep("deadlines");
      h.expectTerminal("FIZZLED", m().sideFizzled("Silent Disco"));
      h.expectPollCount(0);
    },
  },
  {
    label: "D3",
    title: "SCENARIO D3 — one complete playlist → default win → finale → CLOSED",
    votes: [],
    run: async (h) => {
      await h.newGame("Solo Act", ["alice"]);
      await h.submit("host");
      h.advanceSec(SUBMISSION_WINDOW_SEC + 86400);
      await h.sweep("deadlines");
      h.expectTerminal("CLOSED", m().sideDefaultWin("Solo Act", "host"));
      h.expectPollCount(0);
      h.expectFinale();
    },
  },
  {
    label: "D4",
    title: "SCENARIO D4 — player account deleted mid-duel → FORFEIT",
    votes: [{ host: 1, alice: 1 }],
    run: async (h) => {
      await h.newGame("Broken Record", ["alice"]);
      await h.submit("host");
      await h.submit("alice");
      await h.playerDeleted("id-alice");
      h.expectTerminal("FORFEIT", m().sideForfeit("Broken Record"));
      h.expectLivePollClosed();
    },
  },
  {
    label: "E",
    title: "SCENARIO E — host cancels mid-duel → CANCELLED, live poll closed",
    votes: [{ host: 2, alice: 1 }],
    expectedStatuses: ["resolved"],
    run: async (h) => {
      await h.newGame("Abandon Ship", ["alice"]);
      await h.submit("host");
      await h.submit("alice");
      h.expectPollCount(1);
      await h.say("host", "cancel", "direct");
      h.expectTerminal("CANCELLED", m().sideCancelled("Abandon Ship"));
      h.expectLivePollClosed();
      const roots = h.rootPosts().length;
      h.check("no finale root posted", roots === 0, `roots ${roots}`);
    },
  },
];

// ── program ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setLocale("en");
  console.log("playlist-battle E2E console harness — real stack, console Mastodon adapter");
  console.log(`bot @${BOT_ACCT} · clock base ${CLOCK_BASE} · db :memory:`);
  console.log(
    args.random
      ? `poll votes: random · seed=${args.seed} (rerun with --seed=${args.seed} to reproduce)`
      : "poll votes: scripted",
  );
  console.log();

  let total = 0;
  let failed = 0;
  const rule = "═".repeat(68);
  for (const scenario of SCENARIOS) {
    console.log(`${rule}\n${scenario.title}\n${rule}`);
    const h = new Harness(args.random ? null : scenario.votes, args.seed, scenario.expectedStatuses ?? []);
    try {
      await scenario.run(h);
    } catch (err) {
      h.check(
        "scenario ran to completion",
        false,
        err instanceof Error ? (err.stack ?? err.message).split("\n").slice(0, 3).join(" | ") : String(err),
      );
    }
    h.reconcile();
    failed += h.finish(scenario.label);
    total += h.checks.length;
    h.close();
  }

  console.log(failed === 0 ? `E2E PASSED (${total} checks)` : `E2E FAILED (${failed} of ${total} checks failed)`);
  if (failed > 0) process.exitCode = 1;
}

/** Only run when invoked as the CLI; the benchmark imports Harness/SCENARIOS. */
const invokedAsCli = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedAsCli) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
