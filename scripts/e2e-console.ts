/**
 * Console E2E harness — replays real games through the real stack
 * (poller → handlers → engine → scheduler → posts) against a console Mastodon
 * adapter, printing every inbound event, every outbound status, every poll's
 * vote input and result, and a per-scenario DB summary.
 *
 *   npm run e2e:console
 *   npm run e2e:console -- --random [--seed=42]
 *
 * Exits non-zero if any check fails. No src/ behavior is touched: the only
 * non-harness edits are the npm script, the tsconfig include and a README line.
 */

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
import type { Game, Player } from "../src/game/types.js";
import type { MastodonClient } from "../src/mastodon/client.js";
import type { RawNotification } from "../src/mastodon/notifications.js";
import { m, setLocale } from "../src/i18n/index.js";
import { createBattlePlaylistPublisher } from "../src/youtube/playlist.js";

// ── constants ───────────────────────────────────────────────

const BOT_ACCT = "playlistbattle";
const INSTANCE_DOMAIN = "mastodon.example";
// Deliberately different from src/config.ts's 900s default: scenarios advance the
// injected clock by a few hours to cross poll expiry, not by minutes per round.
const POLL_DURATION_SEC = 3600;
const ACCEPTANCE_WINDOW_SEC = 86400;
const SUBMISSION_WINDOW_SEC = 172800;
const CREATION_COOLDOWN_SEC = 600;
const MAX_GAMES_PER_PLAYER = 3;
const REPLACEMENT_GRACE_MIN = 15;
const CLOCK_BASE = "2026-01-01T00:00:00.000Z";
const RULE = "═".repeat(68);

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

/** Integer-seeded PRNG — deterministic, no dependency. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── console Mastodon adapter ────────────────────────────────

type PollRecord = { pollId: string; statusId: string; options: string[]; votes: number[] };
type ConsolePost = { id: string; body: Record<string, unknown> };
type ConsoleClient = {
  post: (path: string, body?: unknown) => Promise<{ id: string; poll?: { id: string; expires_at: string } }>;
  get: (path: string) => Promise<unknown>;
  delete: (path: string) => Promise<unknown>;
  rateLimit: null;
  posts: ConsolePost[];
  polls: PollRecord[];
};

// ── ledger ──────────────────────────────────────────────────

type Ledger = {
  pot: number;
  points: Map<string, number>;
  finalSplit: { total: number; each: number; count: number } | null;
  appliedRounds: Set<number>;
  winners: number;
};

type Check = { label: string; ok: boolean; detail: string | null };

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
  expectedWinner: string | null;
  potAwarded: number;
};

// ── harness ─────────────────────────────────────────────────

class Harness {
  readonly db: Db;
  readonly deps: HandlerDeps;
  readonly client: ConsoleClient;
  readonly botAcct = BOT_ACCT;
  readonly checks: Check[] = [];
  readonly ledger: Ledger = {
    pot: 0,
    points: new Map<string, number>(),
    finalSplit: null,
    appliedRounds: new Set<number>(),
    winners: 0,
  };
  gameId: string | null = null;
  private readonly deadVideos = new Set<string>();

  private readonly schedDeps: SchedulerDeps;
  private readonly queue: RawNotification[] = [];
  private readonly votes: Record<string, number>[] | null;
  private readonly rng: () => number;
  private readonly expectedStatuses: string[];
  private clock = new Date(CLOCK_BASE);
  private notifSeq = 0;
  private postSeq = 0;
  private gameSeq = 0;
  private voteCursor = 0;

  constructor(opts: { votes: Record<string, number>[] | null; seed: number; expectedStatuses: string[] }) {
    this.votes = opts.votes;
    this.rng = mulberry32(opts.seed);
    this.expectedStatuses = opts.expectedStatuses;
    this.db = openDatabase(":memory:");
    migrate(this.db);

    const client: ConsoleClient = {
      rateLimit: null,
      posts: [],
      polls: [],
      post: async (path, body) => {
        if (path !== "/api/v1/statuses") throw new Error(`console client: unexpected POST ${path}`);
        const payload = (body ?? {}) as Record<string, unknown>;
        const n = (this.postSeq += 1);
        const id = `s-${n}`;
        const poll = payload.poll as { options: string[]; expires_in: number } | undefined;
        let pollResult: { id: string; expires_at: string } | undefined;
        if (poll) {
          const options = poll.options;
          const votes = this.nextVotes(options);
          const pollId = `poll-${n}`;
          const expiresAt = new Date(this.clock.getTime() + poll.expires_in * 1000).toISOString();
          client.polls.push({ pollId, statusId: id, options, votes });
          pollResult = { id: pollId, expires_at: expiresAt };
        }
        client.posts.push({ id, body: payload });
        this.printPost(id, payload);
        return pollResult ? { id, poll: pollResult } : { id };
      },
      get: async (path) => {
        if (path.startsWith("/api/v1/notifications")) {
          const batch = [...this.queue];
          this.queue.length = 0;
          return batch;
        }
        if (path.startsWith("/api/v1/polls/")) {
          const pollId = path.slice("/api/v1/polls/".length);
          const record = client.polls.find((p) => p.pollId === pollId);
          if (!record) throw new Error(`console client: unknown poll ${pollId}`);
          this.printVote(record);
          return {
            expired: true,
            options: record.options.map((title, i) => ({ title, votes_count: record.votes[i] ?? 0 })),
          };
        }
        throw new Error(`console client: unexpected GET ${path}`);
      },
      delete: async (path) => {
        const prefix = "/api/v1/statuses/";
        if (!path.startsWith(prefix)) throw new Error(`console client: unexpected DELETE ${path}`);
        const statusId = path.slice(prefix.length);
        const poll = client.polls.find((p) => p.statusId === statusId);
        if (poll) client.polls.splice(client.polls.indexOf(poll), 1);
        client.posts = client.posts.filter((p) => p.id !== statusId);
        console.log(`[DEL ] status ${statusId} removed${poll ? ` (poll ${poll.pollId})` : ""}`);
        console.log();
        return {};
      },
    };
    this.client = client;

    const deps: HandlerDeps = {
      db: this.db,
      client: client as unknown as MastodonClient,
      botAcct: BOT_ACCT,
      instanceDomain: INSTANCE_DOMAIN,
      pollDurationSec: POLL_DURATION_SEC,
      acceptanceWindowSec: ACCEPTANCE_WINDOW_SEC,
      submissionWindowSec: SUBMISSION_WINDOW_SEC,
      creationCooldownSec: CREATION_COOLDOWN_SEC,
      maxGamesPerPlayer: MAX_GAMES_PER_PLAYER,
      lookup: async (acct: string) => ({
        id: `id-${acct}`,
        acct,
        username: acct,
      }),
      resolveTitle: async (videoId: string) => ({
        videoId,
        title: `Track ${videoId}`,
        author: "Artist",
        canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
      }),
      checkAvailable: async (videoId: string) => !this.deadVideos.has(videoId),
      // Anonymous queue links only: the console harness never touches an account.
      publishBattlePlaylist: createBattlePlaylistPublisher(),
      replacementGraceMin: REPLACEMENT_GRACE_MIN,
      now: () => this.clock,
      newGameId: () => `g-${(this.gameSeq += 1)}`,
    };
    // Same wiring as src/index.ts, so the poll-notification fast path is real.
    deps.onPollExpired = async (statusId) => {
      await checkPollNotification(this.schedDeps, statusId);
    };
    this.deps = deps;
    this.schedDeps = { handler: deps, now: deps.now };
  }

  // ── driving ───────────────────────────────────────────────

  advance(ms: number): void {
    this.clock = new Date(this.clock.getTime() + ms);
    console.log(`[CLOCK] +${Math.round(ms / 1000)}s → ${this.clock.toISOString()}`);
  }

  async say(acct: string, content: string, opts: { visibility?: "public" | "direct" } = {}): Promise<void> {
    const visibility = opts.visibility ?? "public";
    this.printIn(acct, visibility, content);
    this.notifSeq += 1;
    const seq = this.notifSeq;
    this.queue.push({
      id: String(1000 + seq),
      type: "mention",
      created_at: this.clock.toISOString(),
      account: { id: `id-${acct}`, acct, username: acct },
      status: {
        id: `s-in-${seq}`,
        visibility,
        in_reply_to_id: null,
        content: `<p>${content.replace(/\n/g, "<br />")}</p>`,
        mentions: [{ id: "bot-1", username: BOT_ACCT, acct: BOT_ACCT }],
      },
    });
    await pollNotifications(this.deps);
    this.requireDrained();
  }

  async pollExpired(statusId: string): Promise<void> {
    this.db
      .prepare("UPDATE rounds SET poll_expires_at = ? WHERE poll_status_id = ?")
      .run(new Date(this.clock.getTime() - 1).toISOString(), statusId);
    console.log(`[IN  ] poll expired · ${statusId}`);
    this.notifSeq += 1;
    const seq = this.notifSeq;
    this.queue.push({
      id: String(1000 + seq),
      type: "poll",
      created_at: this.clock.toISOString(),
      account: { id: "bot-1", acct: BOT_ACCT, username: BOT_ACCT },
      status: {
        id: statusId,
        visibility: "public",
        in_reply_to_id: null,
        content: "",
        mentions: [],
      },
    });
    await pollNotifications(this.deps);
    this.requireDrained();
  }

  async sweepPolls(): Promise<void> {
    console.log("[SWEEP] checkPolls");
    await checkPolls(this.schedDeps);
  }

  async sweepDeadlines(): Promise<void> {
    console.log("[SWEEP] checkDeadlines");
    await checkDeadlines(this.schedDeps);
  }

  async playerDeleted(accountId: string): Promise<void> {
    console.log(`[EVNT] player deleted · ${accountId}`);
    await handlePlayerDeleted(this.deps, accountId);
  }

  markVideoDead(videoId: string): void {
    console.log(`[EVNT] video unavailable · ${videoId}`);
    this.deadVideos.add(videoId);
  }

  markVideoAlive(videoId: string): void {
    console.log(`[EVNT] video available again · ${videoId}`);
    this.deadVideos.delete(videoId);
  }

  /** Poll votes are decided at poll-creation time: scripted vector, or RNG fuzz. */
  private nextVotes(options: string[]): number[] {
    if (this.votes) {
      const spec = this.votes[this.voteCursor];
      this.voteCursor += 1;
      if (!spec) {
        throw new Error(
          `scripted votes: missing vector for poll #${this.voteCursor} (scenario declared ${this.votes.length})`,
        );
      }
      const handles = Object.keys(spec);
      if (handles.length !== options.length) {
        throw new Error(
          `scripted votes: poll #${this.voteCursor} has ${options.length} options but its vector names ${handles.length} players`,
        );
      }
      return options.map((option, index) => {
        const handle = handles.find((h) => option.startsWith(`${h}: `));
        if (!handle) {
          throw new Error(
            `scripted votes: poll #${this.voteCursor} option ${index} ("${option}") matches none of ${handles.join(", ")}`,
          );
        }
        const value = spec[handle];
        if (typeof value !== "number") {
          throw new Error(`scripted votes: poll #${this.voteCursor} has no vote count for @${handle}`);
        }
        return value;
      });
    }
    return Array.from({ length: options.length }, () => Math.floor(this.rng() * 7));
  }

  private requireDrained(): void {
    if (this.queue.length > 0) {
      throw new Error(
        `console client: ${this.queue.length} queued notification(s) were not consumed by pollNotifications`,
      );
    }
  }

  // ── transcript printing ───────────────────────────────────

  private printIn(acct: string, visibility: string, content: string): void {
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    const isLinkDm = lines.length > 0 && lines.every((l) => /^https?:\/\//.test(l.trim()));
    let desc: string;
    if (isLinkDm) {
      desc = `${lines.length} links`;
    } else {
      desc = lines[0] ?? content;
      if (lines.length > 1) desc += ` · (+${lines.length - 1} more lines)`;
    }
    console.log(`[IN  ] @${acct} · ${visibility} · ${desc}`);
    console.log();
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

  private printVote(record: PollRecord): void {
    const parts = record.options.map((title, i) => `${i}) ${title} = ${record.votes[i] ?? 0}`);
    console.log(`[VOTE] ${record.pollId} · ${parts.join(" · ")}`);
    console.log();
  }

  note(text: string): void {
    console.log(`[NOTE] ${text}`);
  }

  check(label: string, ok: boolean, detail?: string): void {
    this.checks.push({ label, ok, detail: detail ?? null });
    if (!ok) console.log(`❌ ${label}${detail ? ` — ${detail}` : ""}`);
  }

  // ── DB helpers ────────────────────────────────────────────

  onlyGameId(): string {
    const row = this.db
      .prepare("SELECT id FROM games ORDER BY created_at DESC LIMIT 1")
      .get() as { id: string } | undefined;
    if (!row) throw new Error("harness: no game row");
    return row.id;
  }

  roundRows(gameId: string): RoundRow[] {
    return this.db
      .prepare(
        `SELECT number, status, winner_account_id, option_map_json, poll_status_id
         FROM rounds WHERE game_id = ? ORDER BY number`,
      )
      .all(gameId) as RoundRow[];
  }

  pollStatusIdFor(gameId: string, round: number): string {
    const row = this.db
      .prepare("SELECT poll_status_id FROM rounds WHERE game_id = ? AND number = ?")
      .get(gameId, round) as { poll_status_id: string | null } | undefined;
    if (!row?.poll_status_id) throw new Error(`harness: round ${round} has no poll`);
    return row.poll_status_id;
  }

  countPolls(gameId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM rounds WHERE game_id = ? AND poll_status_id IS NOT NULL")
      .get(gameId) as { c: number };
    return row.c;
  }

  /**
   * Locale-independent probe for the final-split line: the catalog line with its
   * numbers blanked, so a copy edit cannot make the absence check vacuous.
   */
  private splitLineProbe(): RegExp {
    const sentinel = "424242";
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const parts = m().finalePotSplit(Number(sentinel), Number(sentinel), Number(sentinel))
      .split(sentinel)
      .map(escape);
    return new RegExp(parts.join("\\d+"));
  }

  private seedLedger(gameId: string): void {
    for (const p of loadPlayers(this.db, gameId)) {
      if (!this.ledger.points.has(p.accountId)) this.ledger.points.set(p.accountId, 0);
    }
  }

  private acctOf(players: Player[], accountId: string): string {
    return players.find((p) => p.accountId === accountId)?.acct ?? accountId;
  }

  /** Participants holding a tune at (game, round): mirrors eligibleForRound. */
  private roundParticipants(gameId: string, round: number): string[] {
    const players = loadPlayers(this.db, gameId);
    const tunes = loadTunes(this.db, gameId);
    const hasTune = new Set(
      tunes.filter((t) => t.position === round).map((t) => t.accountId),
    );
    return players.filter((p) => p.inviteStatus === "accepted" && hasTune.has(p.accountId)).map((p) => p.accountId);
  }

  // ── ledger / reconciliation ───────────────────────────────

  /**
   * Independent model of the PRD scoring rules, fed only by the votes the
   * harness injected — never by engine internals. Mirrors
   * resolveRoundScore (quorum) + resolveRound (final split of the PRE-round
   * pot, no growth on a final tie).
   */
  private applyRound(game: Game, row: RoundRow): RoundResult {
    const QUORUM = 3;
    const isFinal = row.number >= game.playlistLength;
    const potBefore = this.ledger.pot;
    let kind: RoundResult["kind"];
    let winner: string | null = null;
    let expectedWinner: string | null = null;
    let potAwarded = 0;
    let tallies = new Map<string, number>();
    let top: [string, number] | undefined;

    if (row.status === "resolved" && row.poll_status_id === null && row.winner_account_id === null) {
      // Round closed without being scored: the game was voided (a deleted or
      // unreachable player closes any open poll). No votes, no pot movement.
      return { kind: "void", winner: null, expectedWinner: null, potAwarded: 0 };
    }

    if (row.status === "auto_tied") {
      kind = "auto_tie";
      if (isFinal) {
        // v1.1 1.3 final auto-tie: split the pre-round pot among all round
        // participants (no poll ran, so everyone is tied). No pot growth.
        const tiedIds = this.roundParticipants(game.id, row.number);
        const count = tiedIds.length;
        const each = count > 0 ? Math.floor(potBefore / count) : 0;
        const total = each * count;
        if (total > 0) {
          for (const id of tiedIds) {
            this.ledger.points.set(id, (this.ledger.points.get(id) ?? 0) + each);
          }
        }
        this.ledger.finalSplit = total > 0 ? { total, each, count } : null;
        this.ledger.pot = 0;
      } else {
        this.ledger.pot = potBefore + 1;
      }
    } else if (row.status === "walkover") {
      kind = "walkover";
      winner = row.winner_account_id;
      expectedWinner = row.winner_account_id;
      if (winner) {
        potAwarded = this.ledger.pot;
        this.ledger.points.set(winner, (this.ledger.points.get(winner) ?? 0) + potAwarded);
        this.ledger.pot = 0;
      }
    } else {
      kind = "poll";
      const record = this.client.polls.find((p) => p.statusId === row.poll_status_id);
      if (!record) {
        this.check(`R${row.number} votes recorded`, false, `no poll record for ${row.poll_status_id}`);
        this.ledger.pot += 1;
        return { kind, winner: null, expectedWinner: null, potAwarded: 0 };
      }
      const optionMap = JSON.parse(row.option_map_json) as Record<string, string>;
      tallies = new Map();
      record.options.forEach((_title, i) => {
        const accountId = optionMap[String(i)];
        if (!accountId) return;
        tallies.set(accountId, (tallies.get(accountId) ?? 0) + (record.votes[i] ?? 0));
      });
      for (const [accountId, votes] of tallies) {
        this.ledger.points.set(accountId, (this.ledger.points.get(accountId) ?? 0) + votes);
      }
      const ranked = [...tallies.entries()].sort((a, b) => b[1] - a[1]);
      top = ranked[0];
      const totalVotes = [...tallies.values()].reduce((s, v) => s + v, 0);
      const tied = ranked.filter((entry) => entry[1] === top?.[1]);
      // v1.1 1.2 quorum: fewer than QUORUM total votes → always a tie.
      if (!top || tied.length > 1 || top[1] === 0 || totalVotes < QUORUM) {
        expectedWinner = null;
        if (!isFinal) this.ledger.pot = potBefore + 1;
      } else {
        expectedWinner = top[0];
        winner = top[0];
        potAwarded = potBefore;
        this.ledger.points.set(winner, (this.ledger.points.get(winner) ?? 0) + potAwarded);
        this.ledger.pot = 0;
      }
    }

    if (isFinal && winner === null && kind === "poll") {
      // v1.1 1.3: final-round tie splits the PRE-round pot (no growth).
      // Quorum-forced tie with a unique leader → all participants share.
      const totalVotes = [...tallies.values()].reduce((s, v) => s + v, 0);
      const uniqueLeader =
        top !== undefined && top[1] > 0 && [...tallies.values()].filter((v) => v === top[1]).length === 1;
      const quorumForced = tallies.size > 0 && totalVotes < QUORUM && uniqueLeader;
      let tiedIds: string[];
      if (quorumForced) {
        tiedIds = [...tallies.keys()];
      } else {
        const topVotes = top?.[1] ?? 0;
        tiedIds = [...tallies.keys()].filter((id) => (tallies.get(id) ?? 0) === topVotes);
      }
      const count = tiedIds.length;
      const each = count > 0 ? Math.floor(potBefore / count) : 0;
      const total = each * count;
      if (total > 0) {
        for (const id of tiedIds) {
          this.ledger.points.set(id, (this.ledger.points.get(id) ?? 0) + each);
        }
      }
      this.ledger.finalSplit = total > 0 ? { total, each, count } : null;
      this.ledger.pot = 0;
    }
    if (winner) this.ledger.winners += 1;
    return { kind, winner, expectedWinner, potAwarded };
  }

  private stateProblems(game: Game, players: Player[]): string[] {
    const problems: string[] = [];
    if (game.pot !== this.ledger.pot) problems.push(`pot db ${game.pot} ≠ ledger ${this.ledger.pot}`);
    for (const p of players) {
      const expected = this.ledger.points.get(p.accountId) ?? 0;
      if (p.points !== expected) problems.push(`@${p.acct} points db ${p.points} ≠ ledger ${expected}`);
    }
    return problems;
  }

  private resultLabel(kind: RoundResult["kind"], winnerAcct: string | null): string {
    if (kind === "void") return "void (game closed unscored)";
    if (kind === "auto_tie") return "auto-tie";
    if (kind === "walkover") {
      return winnerAcct ? `walkover @${winnerAcct}` : "walkover (no eligible player)";
    }
    return winnerAcct ? `winner @${winnerAcct}` : "tie";
  }

  private printResult(row: RoundRow, result: RoundResult, players: Player[], ok: boolean, problems: string[]): void {
    const desc = this.resultLabel(
      result.kind,
      result.winner ? this.acctOf(players, result.winner) : null,
    );
    const points = [...players]
      .map((p) => ({ acct: p.acct, points: this.ledger.points.get(p.accountId) ?? 0 }))
      .sort((a, b) => b.points - a.points || a.acct.localeCompare(b.acct))
      .map((e) => `@${e.acct} ${e.points}`)
      .join(" · ");
    console.log(
      `[RSLT] R${row.number} · ${desc} · pot awarded ${result.potAwarded} · points ${points} · pot ${this.ledger.pot} · ${ok ? "✓" : `✗ ${problems.join("; ")}`}`,
    );
    console.log();
  }

  /**
   * Walk every round not yet modelled, ascending, applying the ledger rule and
   * checking the DB against it. Runs after every driving action because a single
   * action can cascade (a poll resolution can trigger walkovers through the finale).
   */
  reconcile(gameId: string): void {
    const game = loadGame(this.db, gameId);
    if (!game) {
      this.check(`game ${gameId} readable`, false, "game row missing");
      return;
    }
    this.seedLedger(gameId);
    const rows = this.roundRows(gameId);
    const players = loadPlayers(this.db, gameId);
    const terminal = (status: string) =>
      status === "resolved" || status === "auto_tied" || status === "walkover";
    const pending = rows.filter((r) => terminal(r.status) && !this.ledger.appliedRounds.has(r.number));
    const unresolved = rows.some((r) => !terminal(r.status));
    let lastApplied: number | null = null;

    for (const [index, row] of pending.entries()) {
      const result = this.applyRound(game, row);
      this.ledger.appliedRounds.add(row.number);
      lastApplied = row.number;

      const problems: string[] = [];
      const expected = this.expectedStatuses[row.number - 1];
      if (expected !== undefined && row.status !== expected) {
        problems.push(`status ${row.status} ≠ ${expected}`);
      }
      if (result.kind === "poll" && result.expectedWinner !== row.winner_account_id) {
        problems.push(`winner ${row.winner_account_id ?? "null"} ≠ ledger ${result.expectedWinner ?? "null"}`);
      }
      const isLast = index === pending.length - 1;
      if (isLast && !unresolved) problems.push(...this.stateProblems(game, players));

      this.printResult(row, result, players, problems.length === 0, problems);
      if (expected !== undefined) {
        this.check(`R${row.number} status`, row.status === expected, `db ${row.status} vs expected ${expected}`);
      }
      if (result.kind === "poll") {
        this.check(
          `R${row.number} winner`,
          result.expectedWinner === row.winner_account_id,
          `db ${row.winner_account_id ?? "null"} vs ledger ${result.expectedWinner ?? "null"}`,
        );
      }
    }

    if (lastApplied !== null && !unresolved) {
      this.check(`R${lastApplied} pot`, game.pot === this.ledger.pot, `db ${game.pot} vs ledger ${this.ledger.pot}`);
      for (const p of players) {
        const expected = this.ledger.points.get(p.accountId) ?? 0;
        this.check(
          `R${lastApplied} points @${p.acct}`,
          p.points === expected,
          `db ${p.points} vs ledger ${expected}`,
        );
      }
    }
  }

  // ── scenario assertions ───────────────────────────────────

  expectTerminal(gameId: string, expected: string): void {
    const game = loadGame(this.db, gameId);
    this.check(`game status is ${expected}`, game?.status === expected, `actual ${game?.status ?? "missing"}`);
    if (expected === "CLOSED") {
      this.check("pot is 0 after CLOSED", (game?.pot ?? -1) === 0, `pot ${game?.pot}`);
    }
  }

  /** Public root statuses posted so far — a finale is the only root a game posts. */
  rootPostCount(): number {
    return this.client.posts.filter((p) => !p.body.in_reply_to_id && p.body.visibility === "public").length;
  }

  expectPollCount(gameId: string, expected: number): void {
    const actual = this.countPolls(gameId);
    this.check(`poll count is ${expected}`, actual === expected, `actual ${actual}`);
  }

  expectStatusVector(gameId: string, expected: string[]): void {
    const actual = this.roundRows(gameId).map((r) => r.status);
    this.check(
      "round status vector",
      actual.join(",") === expected.join(","),
      `actual ${actual.join(",")} vs expected ${expected.join(",")}`,
    );
  }

  expectSideEffect(
    kind: "expired" | "fizzled" | "forfeit" | "cancelled" | "default_win",
    theme: string,
    winnerAcct?: string,
  ): void {
    // Mirrors SIDE_EFFECT_COPY in src/mastodon/posts.ts — same kinds, same catalog.
    const copy: Record<typeof kind, (t: string, winner: string) => string> = {
      expired: (t) => m().sideExpired(t),
      fizzled: (t) => m().sideFizzled(t),
      forfeit: (t) => m().sideForfeit(t),
      cancelled: (t) => m().sideCancelled(t),
      default_win: (t, winner) => m().sideDefaultWin(t, winner),
    };
    const expected = copy[kind](theme, winnerAcct ?? "?");
    const found = this.client.posts.some((p) => String(p.body.status ?? "") === expected);
    this.check(`side-effect post (${kind})`, found, expected);
  }

  /**
   * Finale summary checks — all derived from the ledger, never hardcoded.
   * Returns the summary text (empty when no summary was posted).
   */
  expectFinale(gameId: string): string {
    this.seedLedger(gameId);
    const all = loadPlayers(this.db, gameId);
    // Mirrors emitFinale: only players who actually dueled can be crowned.
    const duelers = all.filter((p) => p.inviteStatus === "accepted");
    const ranked = duelers.map((p) => ({
      acct: p.acct,
      accountId: p.accountId,
      points: this.ledger.points.get(p.accountId) ?? 0,
    }));
    const top = Math.max(0, ...ranked.map((e) => e.points));
    const champions = ranked
      .filter((e) => e.points === top)
      .sort((a, b) => a.accountId.localeCompare(b.accountId))
      .map((e) => e.acct);

    const roots = this.client.posts.filter(
      (p) => !p.body.in_reply_to_id && p.body.visibility === "public",
    );
    const summary = roots.at(-1);
    this.check(
      "finale summary posted as a root status",
      Boolean(summary),
      summary ? undefined : "no root public status found",
    );
    if (!summary) return "";

    const text = String(summary.body.status ?? "");
    for (const acct of champions) {
      this.check(`finale names @${acct}`, text.includes(`@${acct}`), text.split("\n")[0] ?? "");
    }
    const withdrawn = all.filter((p) => p.inviteStatus !== "accepted");
    for (const p of withdrawn) {
      this.check(
        `finale never crowns withdrawn @${p.acct}`,
        !text.includes(`@${p.acct}`),
        text.replace(/\n/g, " | "),
      );
    }
    const replies = this.client.posts.filter((p) => p.body.in_reply_to_id === summary.id);
    this.check(
      "finale tune replies match ledger winners",
      replies.length === this.ledger.winners,
      `${replies.length} replies vs ${this.ledger.winners} winning rounds`,
    );
    if (this.ledger.finalSplit) {
      const line = m().finalePotSplit(
        this.ledger.finalSplit.total,
        this.ledger.finalSplit.each,
        this.ledger.finalSplit.count,
      );
      this.check(
        `finale reports pot split ${this.ledger.finalSplit.total} → ${this.ledger.finalSplit.each}×${this.ledger.finalSplit.count}`,
        text.includes(line),
        text.replace(/\n/g, " | "),
      );
    } else {
      this.check("finale has no split line", !this.splitLineProbe().test(text), text.replace(/\n/g, " | "));
    }
    return text;
  }

  // ── footers ───────────────────────────────────────────────

  finish(label: string): { total: number; failed: number } {
    const gameId = this.gameId;
    if (gameId) {
      const game = loadGame(this.db, gameId);
      const players = loadPlayers(this.db, gameId);
      const rounds = this.roundRows(gameId);
      if (game) {
        console.log("── state ───────────────────────────────────────────────────────────");
        console.log(
          `game ${game.id} · ${game.status} · pot ${game.pot} · round ${game.currentRound} · theme "${game.theme}"`,
        );
        console.log(
          `rounds  ${rounds.map((r) => `R${r.number} ${r.status}(${this.winnerLabel(r, players)})`).join(" · ") || "—"}`,
        );
        console.log(`points  ${players.map((p) => `@${p.acct} ${p.points}`).join(" · ")}`);
        console.log(`posts   ${this.client.posts.length} statuses · ${this.client.polls.length} polls`);
      }
    }
    const failed = this.checks.filter((c) => !c.ok);
    console.log("── checks ──────────────────────────────────────────────────────────");
    for (const c of this.checks) {
      console.log(`${c.ok ? "✅" : "❌"} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
    }
    console.log(
      `scenario ${label}: ${failed.length === 0 ? "PASS" : "FAIL"} (${this.checks.length} checks)`,
    );
    console.log();
    return { total: this.checks.length, failed: failed.length };
  }

  private winnerLabel(row: RoundRow, players: Player[]): string {
    if (row.winner_account_id) return this.acctOf(players, row.winner_account_id);
    if (row.status === "walkover") return "none";
    if (row.status === "resolved") return row.poll_status_id === null ? "void" : "tie";
    if (row.status === "auto_tied") return "tie";
    return "open";
  }
}

// ── shared scenario helpers ─────────────────────────────────

function videoIdFor(acct: string, index: number): string {
  const base = acct.replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(8, "0");
  return `${base}${String(index).padStart(3, "0")}`.slice(0, 11);
}

function ids(acct: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => videoIdFor(acct, i + 1));
}

async function createGame(
  h: Harness,
  opts: { theme: string; length: number; host: string; challengers: string[]; accept: string[] },
): Promise<string> {
  const mentions = opts.challengers.map((c) => `@${c}`).join(" ");
  await h.say(opts.host, `@${h.botAcct} newgame "${opts.theme}" ${opts.length} ${mentions}`);
  for (const acct of opts.accept) await h.say(acct, "accept", { visibility: "direct" });
  const gameId = h.onlyGameId();
  h.gameId = gameId;
  return gameId;
}

async function submit(h: Harness, acct: string, videoIds: string[]): Promise<void> {
  const body = videoIds.map((v) => `https://www.youtube.com/watch?v=${v}`).join("\n");
  await h.say(acct, body, { visibility: "direct" });
}

// ── scenarios ───────────────────────────────────────────────

/** A — 2 players · wins, ties, pot carry, split final pot (v1.1 1.2 quorum-safe). */
const VOTES_A: Record<string, number>[] = [
  { host: 5, alice: 3 }, // R1 clear win, empty pot
  { host: 2, alice: 2 }, // R2 2-way tie → pot 1
  { host: 4, alice: 0 }, // R3 win takes pot
  { host: 0, alice: 0 }, // R4 all-zero tie → pot 1
  { host: 1, alice: 3 }, // R5 win takes pot
  { host: 6, alice: 1 }, // R6 clear win, empty pot
  { host: 0, alice: 3 }, // R7 win with zero pot (quorum-safe: 3 total votes)
  { host: 3, alice: 3 }, // R8 final tie → split pre-round pot
];

async function scenarioA(h: Harness): Promise<void> {
  const gameId = await createGame(h, {
    theme: "80s Synth",
    length: 8,
    host: "host",
    challengers: ["alice"],
    accept: ["alice"],
  });
  await submit(h, "host", ids("host", 8));
  await submit(h, "alice", ids("alice", 8));
  h.reconcile(gameId);

  // R1 resolves through the periodic sweep; R2–R8 through poll notifications.
  h.advance(POLL_DURATION_SEC * 1000 + 1000);
  await h.sweepPolls();
  h.reconcile(gameId);

  for (let round = 2; round <= 8; round += 1) {
    await h.pollExpired(h.pollStatusIdFor(gameId, round));
    h.reconcile(gameId);
  }

  h.expectTerminal(gameId, "CLOSED");
  h.expectPollCount(gameId, 8);
  h.expectFinale(gameId);
}

/** B — 3 players · multi-way ties + final split + shared championship. */
const VOTES_B: Record<string, number>[] = [
  { host: 2, bob: 2, carol: 2 }, // R1 3-way tie → pot 1
  { host: 5, bob: 1, carol: 0 }, // R2 win takes pot
  { host: 0, bob: 4, carol: 4 }, // R3 2-way tie → pot 1
  { host: 3, bob: 0, carol: 3 }, // R4 2-way tie → pot 2
  { host: 0, bob: 0, carol: 0 }, // R5 all-zero tie → pot 3
  { host: 3, bob: 3, carol: 1 }, // R6 2-way tie → pot 4 (builds the final split)
  { host: 4, bob: 0, carol: 4 }, // R7 2-way tie → pot 5
  { host: 2, bob: 2, carol: 0 }, // R8 final tie → split pre-round pot
];

async function scenarioB(h: Harness): Promise<void> {
  const gameId = await createGame(h, {
    theme: "Guilty Pleasures",
    length: 8,
    host: "host",
    challengers: ["bob", "carol"],
    accept: ["bob", "carol"],
  });
  await submit(h, "host", ids("host", 8));
  await submit(h, "bob", ids("bob", 8));
  await submit(h, "carol", ids("carol", 8));
  h.reconcile(gameId);

  for (let round = 1; round <= 8; round += 1) {
    await h.pollExpired(h.pollStatusIdFor(gameId, round));
    h.reconcile(gameId);
  }

  h.expectTerminal(gameId, "CLOSED");
  h.expectPollCount(gameId, 8);
  h.expectFinale(gameId);
}

/** C — v1.1: auto-tie + unavailable video → single-round forfeit → walkover. */
const VOTES_C: Record<string, number>[] = [
  { host: 5, alice: 3 }, // R1 host wins, pot 0
  { host: 1, alice: 4 }, // R3 alice wins, pot 0
  { host: 4, alice: 2 }, // R4 host wins, pot 0
  { host: 3, alice: 1 }, // R6 host wins, pot 0
  { host: 2, alice: 4 }, // R7 alice wins, pot 0
  { host: 3, alice: 1 }, // R8 host wins, takes pot 0
];

const STATUSES_C = [
  "resolved",
  "auto_tied",
  "resolved",
  "resolved",
  "walkover",
  "resolved",
  "resolved",
  "resolved",
];

async function scenarioC(h: Harness): Promise<void> {
  const gameId = await createGame(h, {
    theme: "One-Hit Wonders",
    length: 8,
    host: "host",
    challengers: ["alice"],
    accept: ["alice"],
  });
  // Cross-player duplicate at position 2 → automatic tie, no poll for round 2.
  const duplicate = "dup00000001";
  const hostTunes = ids("host", 8);
  const aliceTunes = ids("alice", 8);
  hostTunes[1] = duplicate;
  aliceTunes[1] = duplicate;
  await submit(h, "host", hostTunes);
  await submit(h, "alice", aliceTunes);
  h.reconcile(gameId);

  await h.pollExpired(h.pollStatusIdFor(gameId, 1));
  h.reconcile(gameId); // R1 resolved; R2 auto-ties during the same action

  await h.pollExpired(h.pollStatusIdFor(gameId, 3));
  h.reconcile(gameId); // R3 resolved

  // v1.1 1.4: alice's round-5 tune dies before round 5 is emitted (round 5
  // emits as a side effect of resolving round 4). No replacement arrives, so
  // round 5 is a walkover for the host; rounds 6+ resume as normal polls.
  h.markVideoDead(aliceTunes[4]!);
  await h.pollExpired(h.pollStatusIdFor(gameId, 4));
  h.reconcile(gameId); // R4 resolved; R5 waits on the replacement window

  const r5 = h.roundRows(gameId).find((r) => r.number === 5);
  h.check("R5 waits on replacement window", r5?.status === "announced", `actual ${r5?.status ?? "missing"}`);

  h.advance(REPLACEMENT_GRACE_MIN * 60 * 1000 + 1000);
  await h.sweepDeadlines();
  h.reconcile(gameId); // R5 walkover; R6 poll opens

  await h.pollExpired(h.pollStatusIdFor(gameId, 6));
  h.reconcile(gameId);
  await h.pollExpired(h.pollStatusIdFor(gameId, 7));
  h.reconcile(gameId);
  await h.pollExpired(h.pollStatusIdFor(gameId, 8));
  h.reconcile(gameId);

  h.expectTerminal(gameId, "CLOSED");
  h.expectPollCount(gameId, 6);
  h.expectStatusVector(gameId, STATUSES_C);
  h.expectFinale(gameId);
}

/** D1 — invitation never accepted → EXPIRED. */
async function scenarioD1(h: Harness): Promise<void> {
  const gameId = await createGame(h, {
    theme: "Ghost Town",
    length: 8,
    host: "host",
    challengers: ["alice"],
    accept: [],
  });
  h.advance(ACCEPTANCE_WINDOW_SEC * 1000 + 86400_000);
  await h.sweepDeadlines();
  h.expectTerminal(gameId, "EXPIRED");
  h.expectPollCount(gameId, 0);
  h.expectSideEffect("expired", "Ghost Town");
}

/** D2 — accepted but nobody submits → FIZZLED. */
async function scenarioD2(h: Harness): Promise<void> {
  const gameId = await createGame(h, {
    theme: "Silent Disco",
    length: 8,
    host: "host",
    challengers: ["alice"],
    accept: ["alice"],
  });
  h.advance(SUBMISSION_WINDOW_SEC * 1000 + 86400_000);
  await h.sweepDeadlines();
  h.expectTerminal(gameId, "FIZZLED");
  h.expectPollCount(gameId, 0);
  h.expectSideEffect("fizzled", "Silent Disco");
}

/** D3 — exactly one complete playlist → default win → finale → CLOSED. */
async function scenarioD3(h: Harness): Promise<void> {
  const gameId = await createGame(h, {
    theme: "Solo Act",
    length: 8,
    host: "host",
    challengers: ["alice"],
    accept: ["alice"],
  });
  await submit(h, "host", ids("host", 8));
  h.advance(SUBMISSION_WINDOW_SEC * 1000 + 86400_000);
  await h.sweepDeadlines();
  h.expectTerminal(gameId, "CLOSED");
  h.expectPollCount(gameId, 0);
  h.expectSideEffect("default_win", "Solo Act", "host");
  h.expectFinale(gameId);
}

/** E — host cancels mid-duel → CANCELLED, live poll closed, no finale thread. */
async function scenarioE(h: Harness): Promise<void> {
  const gameId = await createGame(h, {
    theme: "Abandon Ship",
    length: 8,
    host: "host",
    challengers: ["alice"],
    accept: ["alice"],
  });
  await submit(h, "host", ids("host", 8));
  await submit(h, "alice", ids("alice", 8));
  h.reconcile(gameId);
  h.expectPollCount(gameId, 1);

  await h.say("host", "cancel", { visibility: "direct" });

  h.expectTerminal(gameId, "CANCELLED");
  h.expectSideEffect("cancelled", "Abandon Ship");
  const r1 = h.roundRows(gameId)[0];
  h.check(
    "R1 poll closed on cancel",
    r1?.status === "resolved" && r1?.poll_status_id === null,
    `actual ${r1?.status}/${r1?.poll_status_id ?? "null"}`,
  );
  h.check("R1 poll status removed", h.countPolls(gameId) === 0, `polls ${h.countPolls(gameId)}`);
  h.check("no finale root posted", h.rootPostCount() === 0, `roots ${h.rootPostCount()}`);
}

/** D4 — player account deleted mid-duel → FORFEIT. */
async function scenarioD4(h: Harness): Promise<void> {
  const gameId = await createGame(h, {
    theme: "Broken Record",
    length: 8,
    host: "host",
    challengers: ["alice"],
    accept: ["alice"],
  });
  await submit(h, "host", ids("host", 8));
  await submit(h, "alice", ids("alice", 8));
  h.reconcile(gameId);

  await h.playerDeleted("id-alice");
  h.expectTerminal(gameId, "FORFEIT");
  h.expectSideEffect("forfeit", "Broken Record");
  const r1 = h.roundRows(gameId)[0];
  h.check("R1 poll closed on FORFEIT", r1?.status === "resolved", `actual ${r1?.status}`);
  h.check("R1 poll status removed", h.countPolls(gameId) === 0, `polls ${h.countPolls(gameId)}`);
}

// ── program ─────────────────────────────────────────────────

type Scenario = {
  label: string;
  title: string;
  votes: Record<string, number>[] | null;
  expectedStatuses: string[];
  body: (h: Harness) => Promise<void>;
};

const ALL_RESOLVED = Array.from({ length: 8 }, () => "resolved");

const SCENARIOS: Scenario[] = [
  {
    label: "A",
    title: "SCENARIO A — 2 players · 8 rounds · wins, ties, pot carry, split final pot",
    votes: VOTES_A,
    expectedStatuses: ALL_RESOLVED,
    body: scenarioA,
  },
  {
    label: "B",
    title: "SCENARIO B — 3 players · multi-way ties + final split + shared championship",
    votes: VOTES_B,
    expectedStatuses: ALL_RESOLVED,
    body: scenarioB,
  },
  {
    label: "C",
    title: "SCENARIO C — auto-tie + unavailable video · round forfeit · walkover",
    votes: VOTES_C,
    expectedStatuses: STATUSES_C,
    body: scenarioC,
  },
  {
    label: "D1",
    title: "SCENARIO D1 — invitation never accepted → EXPIRED",
    votes: [],
    expectedStatuses: [],
    body: scenarioD1,
  },
  {
    label: "D2",
    title: "SCENARIO D2 — accepted, nobody submits → FIZZLED",
    votes: [],
    expectedStatuses: [],
    body: scenarioD2,
  },
  {
    label: "D3",
    title: "SCENARIO D3 — one complete playlist → default win → finale → CLOSED",
    votes: [],
    expectedStatuses: [],
    body: scenarioD3,
  },
  {
    label: "D4",
    title: "SCENARIO D4 — player account deleted mid-duel → FORFEIT",
    votes: [{ host: 1, alice: 1 }],
    expectedStatuses: [],
    body: scenarioD4,
  },
  {
    label: "E",
    title: "SCENARIO E — host cancels mid-duel → CANCELLED, live poll closed",
    votes: [{ host: 2, alice: 1 }],
    expectedStatuses: ["resolved"],
    body: scenarioE,
  },
];

function printBanner(args: CliArgs): void {
  console.log("playlist-battle E2E console harness — real stack, console Mastodon adapter");
  console.log(`bot @${BOT_ACCT} · clock base ${CLOCK_BASE} · db :memory:`);
  console.log(
    args.random
      ? `poll votes: random · seed=${args.seed} (rerun with --seed=${args.seed} to reproduce)`
      : "poll votes: scripted",
  );
  console.log();
}

function printScenarioHeader(title: string): void {
  console.log(RULE);
  console.log(title);
  console.log(RULE);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setLocale("en");
  printBanner(args);

  let total = 0;
  let failed = 0;
  for (const scenario of SCENARIOS) {
    printScenarioHeader(scenario.title);
    const h = new Harness({
      votes: args.random ? null : scenario.votes,
      seed: args.seed,
      expectedStatuses: scenario.expectedStatuses,
    });
    try {
      await scenario.body(h);
    } catch (err) {
      h.check(
        "scenario ran to completion",
        false,
        err instanceof Error
          ? (err.stack ?? err.message).split("\n").slice(0, 3).join(" | ")
          : String(err),
      );
    }
    if (h.gameId) h.reconcile(h.gameId);
    const result = h.finish(scenario.label);
    total += result.total;
    failed += result.failed;
    h.db.close();
  }

  console.log(failed === 0 ? `E2E PASSED (${total} checks)` : `E2E FAILED (${failed} of ${total} checks failed)`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
