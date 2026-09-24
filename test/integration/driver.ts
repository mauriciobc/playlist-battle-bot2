/**
 * Event-driven E2E driver for the playlist battle bot.
 *
 * Design: this is a state machine, not a script. At every moment it observes
 * the real world (Mastodon) and performs the ONE action the current state
 * calls for. It never sleeps waiting for a message it hopes will arrive, and
 * it never uses a timeout as a pass/fail condition.
 *
 * Every wait is `until(observable, label)`:
 *   - returns as soon as the condition is TRUE  -> the event happened
 *   - throws only after a generous backstop     -> prevents a hang
 *
 * A timeout therefore means "the event never happened" - a real failure to
 * report, not a way to make a phase pass.
 *
 * This is the Playwright model: poll the world, act on change.
 */

import { readFileSync } from "node:fs";
import { driverExitCode } from "./driver-exit.js";
import { alreadyVotedOn, castPlan, shouldStopVoting } from "./vote-planner.js";
import { resolveBaseUrl } from "./mastodon-helpers.js";
import { openGames } from "../../src/game/types.js";
import { isRefusal, isRefusalText, looksLikeAcceptance } from "./driver-replies.js";
import {  MastodonAPI,
  acctMatches,
  qualifyAcct,
  type MastodonPoll,
} from "./mastodon-helpers.js";

// ─── Config ────────────────────────────────────────────────────────────

interface Cfg {
  hostInstance: string;
  /** Resolved API origins. Explicit *_API_URL wins; else https://<instance>. */
  hostApiUrl: string;
  botApiUrl: string;
  player1ApiUrl: string;
  hostToken: string;
  hostAcct: string;
  botAcct: string;
  botInstance: string;
  player1Instance: string;
  player1Token: string;
  player1Acct: string;
  /**
   * A third voter, needed to reach ROUND_QUORUM (3). The two players
   * always tie without it, and the bot cannot supply the third vote
   * because it owns the poll.
   */
  voter1Token: string;
  voter1ApiUrl: string;
  theme: string;
  playlistLength: number;
  /** Rounds the proven tune pool can actually fill. */
  maxRounds: number;
  /** Rounds the operator asked for, before clamping. */
  requestedRounds: number;
  pollDurationSec: number;
  tuneUrlsHost: string[];
  tuneUrlsPlayer1: string[];
  debug: boolean;
  backstop: {
    create: number;
    accept: number;
    submit: number;
    poll: number;
    finale: number;
  };
  pollIntervalMs: number;
}

/**
 * Default tunes, used when TUNE_URLS_* is unset.
 *
 * Every id here was observed registering successfully in a live run. Do not
 * add a URL speculatively: a single non-reproducible link is silently dropped
 * by the bot, leaving a player one tune short, which makes a poll impossible
 * and closes the game with a default winner instead of a real contest.
 */
const FALLBACK_TUNES = [
  "https://www.youtube.com/watch?v=OPf0YbXqDm0",
  "https://www.youtube.com/watch?v=09R8_2nJtjg",
  "https://www.youtube.com/watch?v=YQHsXMglC9A",
  "https://www.youtube.com/watch?v=60ItHLz5WEA",
  "https://www.youtube.com/watch?v=3JZ_D3ELwOQ",
  "https://www.youtube.com/watch?v=uelHwf8o7_U",
  "https://www.youtube.com/watch?v=2Vv-BfVoq4g",
  "https://www.youtube.com/watch?v=hT_nvWreIhg",
  // Also proven in live games; the two players cannot share a video in
  // any round, so the pool must be larger than one playlist.
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/watch?v=9bZkp7q19f0",
];

function loadConfig(): Cfg {
  const vals: Record<string, string> = {};
  for (const line of readFileSync("./.env", "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    vals[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }

  const n = (k: string, d: number) => Number(vals[k] || d);
  const split = (k: string) =>
    (vals[k] || "").split(",").map((s) => s.trim()).filter(Boolean);
  // An empty array is truthy in JS, so check length - not truthiness.
  const urls = (k: string) => {
    const fromEnv = split(k);
    return fromEnv.length > 0 ? fromEnv : FALLBACK_TUNES;
  };

  // Both players must hold DIFFERENT videos in every round. If they share
  // one, hasRoundCollision() (src/game/types.ts:125) treats the round as a
  // tie and the bot never creates a poll - which is why every run finished
  // auto_tied in seconds and the driver never got to vote. Rotating the
  // fallback list by half its length pairs each round with a different video
  // for the other player.
  //
  // An explicit TUNE_URLS_PLAYER1 in the environment is trusted as-is: if
  // it overlaps the host's list on purpose, that is the operator's call.
  // Deal alternately from one pool: even indices to the host, odd indices to
  // the player. No two players then hold the same video in the same round.
  // Slicing or rotating a single list cannot do this - it only reorders the
  // same URLs, so every round still collides and the bot auto-ties instead
  // of polling (src/game/types.ts:125, hasRoundCollision).
  const envHost = split("TUNE_URLS_HOST");
  const envPlayer = split("TUNE_URLS_PLAYER1");
  const pool = envHost.length > 0 ? envHost : FALLBACK_TUNES;
  const half = Math.floor(pool.length / 2);
  const hostUrls = envHost.length > 0
    ? envHost
    : pool.filter((_, i) => i % 2 === 0).slice(0, half);
  const playerUrls = envPlayer.length > 0
    ? envPlayer
    : pool.filter((_, i) => i % 2 === 1).slice(0, half);
  const shared = playerUrls.filter((u) => hostUrls.includes(u));
  if (shared.length > 0) {
    throw new Error(
      `host and player share ${shared.length} tune URL(s); each round would auto-tie instead of polling: ${shared.slice(0, 3).join(", ")}`,
    );
  }

  return {
    hostInstance: vals.HOST_INSTANCE || "mastodon.social",
    // Optional explicit origins. A bare host still resolves to https://<host>,
    // so the live runs take the same path as the mock ones.
    hostApiUrl: resolveBaseUrl(vals.HOST_API_URL, vals.HOST_INSTANCE || "mastodon.social"),
    botApiUrl: resolveBaseUrl(vals.BOT_API_URL, vals.BOT_INSTANCE || "mastodon.social"),
    player1ApiUrl: resolveBaseUrl(
      vals.PLAYER1_API_URL,
      vals.PLAYER1_INSTANCE || "ursal.zone",
    ),
    hostToken: vals.HOST_TOKEN || "",
    hostAcct: vals.HOST_ACCT || "",
    botAcct: vals.BOT_ACCT || "mauriciobc",
    botInstance: vals.BOT_INSTANCE || "mastodon.social",
    player1Instance: vals.PLAYER1_INSTANCE || "ursal.zone",
    player1Token: vals.PLAYER1_TOKEN || vals.PLAYER_TOKEN || "",
    player1Acct: vals.PLAYER1_ACCT || "",
    // A third voter, needed to reach ROUND_QUORUM (3): the two players
    // alone always tie by rule, and the bot owns the poll so it cannot
    // supply the third vote. resolveBaseUrl takes (override, host), so the
    // voter's origin is its own override when set, else the player's.
    voter1Token: vals.VOTER1_TOKEN ?? vals.PLAYER1_TOKEN ?? "",
    voter1ApiUrl: resolveBaseUrl(
      vals.VOTER1_API_URL ?? vals.PLAYER1_API_URL,
      vals.PLAYER1_INSTANCE || "ursal.zone",
    ),
    // Unique per run: the theme is how the driver recognises its own game
    // among everything else the bot announces. A fixed name collides with
    // games left over from earlier runs.
    theme: `${vals.GAME_THEME || vals.THEME || "E2E"} r${Date.now().toString(36)}`,
    // Never more rounds than there are distinct videos to fill them: a
    // player one tune short makes the round un-pollable and the game ends
    // with a default winner.
    requestedRounds: n("PLAYLIST_LENGTH", 8),
    playlistLength: Math.min(n("PLAYLIST_LENGTH", 8), Math.floor(pool.length / 2)),
    maxRounds: Math.floor(pool.length / 2),
    pollDurationSec: n("POLL_DURATION_SEC", 300),
    tuneUrlsHost: hostUrls,
    tuneUrlsPlayer1: playerUrls,
    debug: vals.DEBUG === "1" || vals.DEBUG === "true",
    // Deadlines, not waits. A round measured ~140s against the 300s poll and
    // the 120s early close, so 8 rounds need ~1120s; the finale backstop is
    // doubled from 900 to 2400s to cover that with headroom, and the poll
    // backstop from 420 to 900s. The run that timed out was cut at 560s in
    // round 4 of 8 by the runner, not by any of these.
    backstop: {
      create: n("BACKSTOP_CREATE_SEC", 120),
      accept: n("BACKSTOP_ACCEPT_SEC", 180),
      submit: n("BACKSTOP_SUBMIT_SEC", 300),
      poll: n("BACKSTOP_POLL_SEC", 900),
      finale: n("BACKSTOP_FINALE_SEC", 2400),
    },
    pollIntervalMs: n("POLL_INTERVAL_MS", 4000),
  };
}

// ─── World (observability) ─────────────────────────────────────────────

interface Seen {
  id: string;
  at: string;
  text: string;
  visibility: string;
  hasPoll: boolean;
  /** Present when hasPoll — needed to vote. */
  poll?: MastodonPoll | null;
}

class World {
  /** Ignore anything older than the run's start. */
  since = new Date().toISOString();

  /**
   * Theme of the game this run created.
   *
   * The bot drains a backlog of old newgame commands on boot and announces
   * those games too, so a timeline scan can find games this run never
   * created - and then report success for somebody else's work. Every status
   * the bot emits about a game repeats that game's theme, so the theme is
   * the anchor that keeps this run's observations scoped to this run.
   *
   * Status ids are NOT usable for this: the poll and every round result are
   * new statuses the bot creates, not statuses this run posted.
   */
  gameTheme: string | null = null;

  constructor(
    readonly cfg: Cfg,
    readonly host: MastodonAPI,
    readonly player: MastodonAPI,
  ) {}

  get botHandle(): string {
    return `${this.cfg.botAcct}@${this.cfg.botInstance}`;
  }

  get hostHandle(): string {
    return this.cfg.hostAcct.includes("@")
      ? this.cfg.hostAcct
      : `${this.cfg.hostAcct}@${this.cfg.hostInstance}`;
  }

  get playerHandle(): string {
    return this.cfg.player1Acct.includes("@")
      ? this.cfg.player1Acct
      : `${this.cfg.player1Acct}@${this.cfg.player1Instance}`;
  }

  /** Everything the bot has posted since the run began. */
  async botActivity(): Promise<Seen[]> {
    const sts = await this.player.getAccountStatusesByHandle(this.botHandle, 40);
    return sts
      .filter((s) => s.created_at > this.since)
      // Scope to this run's game, but never let the filter hide a poll or a
      // round result: those are the things later steps actually wait for.
      .filter((s) => !this.gameTheme || Boolean(s.poll) || s.content.includes(this.gameTheme))
      .map((s) => ({
        id: s.id,
        at: s.created_at,
        text: s.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        visibility: s.visibility,
        hasPoll: Boolean(s.poll),
        poll: s.poll ?? null,
      }));
  }

  /** Bot statuses visible in a player's conversation with the bot. */
  async playerDmActivity(): Promise<Seen[]> {
    const convs = await this.player.getConversations(40);
    const viewer = this.cfg.player1Instance;
    const out: Seen[] = [];
    for (const c of convs) {
      const s = c.last_status;
      if (!s?.account) continue;
      if (s.created_at <= this.since) continue;
      if (!acctMatches(s.account.acct, viewer, this.botHandle)) continue;
      out.push({
        id: s.id,
        at: s.created_at,
        text: s.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        visibility: s.visibility,
        hasPoll: Boolean(s.poll),
        poll: s.poll ?? null,
      });
    }
    return out;
  }

  /** One-line description of reality, printed while waiting. */
  async snapshot(): Promise<string> {
    try {
      const pub = await this.botActivity();
      const dm = await this.playerDmActivity();
      const bits: string[] = [`public=${pub.length}`, `dm=${dm.length}`];
      // Both lists can legitimately be empty: the theme filter scopes
      // observations to this run's game, and nothing is posted under it yet.
      const newest = pub[0] ?? dm[0];
      bits.push(newest ? `newest="${newest.text.slice(0, 50)}"` : "newest=none");
      return bits.join(" ");
    } catch (e) {
      // Print it whole. A truncated message says "reading 'inc" and you end up
      // guessing which property broke - which is exactly what happened twice
      // while chasing this. Include the stack so the line is not a mystery.
      const err = e as Error;
      const where = err.stack?.split("\n").slice(0, 3).join(" | ") ?? "";
      return `unreadable: ${err.name}: ${err.message} @ ${where}`;
    }
  }
}

const t0 = Date.now();
function say(msg: string) {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);
}

/**
 * Raised when a backstop deadline passes: the event being waited for
 * never happened, so nothing downstream may assume it did.
 */
class Backstop extends Error {
  constructor(
    readonly label: string,
    readonly snapshot: string,
  ) {
    super(`event never occurred: ${label}`);
    this.name = "Backstop";
  }
}

// ─── Driver primitives ─────────────────────────────────────────────────

/**
 * Wait until `probe` yields a truthy value, then return it.
 *
 * This is the only waiting primitive in the driver. The deadline is a
 * backstop against hanging forever, not an expectation about timing.
 */
async function until<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
  backstopSec: number,
  world: World,
): Promise<T> {
  const deadline = Date.now() + backstopSec * 1000;
  let probes = 0;

  while (Date.now() < deadline) {
    probes++;
    try {
      const v = await probe();
      if (v) {
        say(`    ✓ ${label} (${probes} probe${probes === 1 ? "" : "s"})`);
        return v;
      }
    } catch {
      // transient API failure — keep observing
    }
    if (probes % 4 === 0) {
      say(`    … ${label} | world: ${await world.snapshot()}`);
    }
    await new Promise((r) => setTimeout(r, world.cfg.pollIntervalMs));
  }

  throw new Backstop(label, await world.snapshot());
}

interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
  ms: number;
}
const results: StepResult[] = [];

async function step(name: string, fn: () => Promise<string>, world: World) {
  const started = Date.now();
  say(`▶ ${name}`);
  try {
    const detail = await fn();
    results.push({ step: name, ok: true, detail, ms: Date.now() - started });
    say(`  ✓ ${name} — ${detail}`);
  } catch (e) {
    const detail =
      e instanceof Backstop ? `never happened | world: ${e.snapshot}` : String(e);
    results.push({ step: name, ok: false, detail, ms: Date.now() - started });
    say(`  ✗ ${name} — ${detail}`);
    throw e;
  }
}

// ─── The lifecycle ─────────────────────────────────────────────────────

async function main() {
  const cfg = loadConfig();
  const host = new MastodonAPI(cfg.hostApiUrl, cfg.hostToken, cfg.debug);
  const player = new MastodonAPI(
    cfg.player1ApiUrl,
    cfg.player1Token,
    cfg.debug,
  );
  const world = new World(cfg, host, player);

  say("resolving identities…");
  const me = await player.getMe();
  const botId = await player.resolveAccountId(world.botHandle);
  say(`  player  @${me.acct} (${me.id})`);
  say(`  bot     @${world.botHandle} (id ${botId})`);
  say(`  host    @${world.hostHandle}`);
  if (cfg.requestedRounds !== cfg.playlistLength) {
    say(
      `  ! PLAYLIST_LENGTH=${cfg.requestedRounds} but the proven tune pool fills at most ${cfg.maxRounds} rounds (one distinct video per player each) - running ${cfg.playlistLength}`,
    );
  }
  say(`  theme   "${cfg.theme}", ${cfg.playlistLength} tunes, poll ${cfg.pollDurationSec}s`);

  // ── 1. Create ────────────────────────────────────────────────────────
  await step("create", async () => {
    // The author of the public command becomes the host, so the host must
    // post it and name the player as the challenger. Posting as the player
    // made host and challenger the same account, which the bot correctly
    // refused with "Jogador duplicado".
    const content = `@${world.botHandle} newgame "${cfg.theme}" ${cfg.playlistLength} ${world.playerHandle}`;
    const st = await host.postStatus(content);
    say(`  host posted: ${content}`);

    // The bot always answers - so wait for a reply that is NOT a refusal.
    // A refusal means no game exists, and every later step would be
    // operating on a game that was never created.
    const reply = await until(
      async () => {
        const ctx = await host.getStatusContext(st.id);
        const inThread = [...ctx.ancestors, ...ctx.descendants];
        const fromBot = inThread.filter((s) =>
          acctMatches(s.account.acct, cfg.hostInstance, world.botHandle),
        );
        const clean = fromBot.find(
          (s) => !isRefusal(s.content.replace(/<[^>]+>/g, " ")),
        );
        if (!clean && fromBot.length > 0) {
          const why = fromBot[fromBot.length - 1]!.content.replace(/<[^>]+>/g, " ").trim();
          say(`  ! bot refused: ${why.slice(0, 90)}`);
        }
        return clean;
      },
      "bot created the game (not a refusal)",
      cfg.backstop.create,
      world,
    );
    say(`  bot: ${reply.content.replace(/<[^>]+>/g, " ").trim().slice(0, 100)}`);

    // Anchor everything after this to the game's own start, and take
    // ownership of the two statuses this run produced. Later steps observe
    // only these, so a backlog of other games cannot be mistaken for this
    // run's work.
    world.since = st.created_at;
    world.gameTheme = cfg.theme;
    return `game created, thread ${st.id}`;
  }, world);

  // ── 2. Accept ────────────────────────────────────────────────────────
  await step("accept", async () => {
    // The challenger accepts. The bot confirms by DM, which is observable
    // for a cross-instance recipient via /conversations.
    const before = (await world.playerDmActivity()).map((s) => s.id);
    await player.sendBotDM(world.botHandle, "accept");

    // The bot's own answer can be a refusal, so look for the positive
    // acknowledgement and surface anything negative it says on the way.
    const reply = await until(
      async () => {
        const now = await world.playerDmActivity();
        const fresh = now.filter((s) => !before.includes(s.id));
        const refusal = fresh.find((s) => isRefusal(s.text));
        if (refusal) say(`  ! bot refused: ${refusal.text.slice(0, 90)}`);
        // Both locales ship this: "You're in! 🎵" / "Você está dentro! 🎵".
        // looksLikeAcceptance rejects the invitation wording itself, since the
        // bot sends "You're invited to duel" in the message right before.
        return fresh.find((s) => !isRefusal(s.text) && looksLikeAcceptance(s.text));
      },
      "bot acknowledged the acceptance",
      cfg.backstop.accept,
      world,
    );
    return `challenger accepted: ${reply.text.slice(0, 60)}`;
  }, world);

  // ── 3. Submit ────────────────────────────────────────────────────────
  // Fire the submissions, then watch for the state transition. No per-tune
  // ack waiting: the bot only posts a poll once BOTH players are done, and
  // that poll is the signal.
  await step("submit", async () => {
    const all: Array<[MastodonAPI, string, string[]]> = [
      [host, world.hostHandle, cfg.tuneUrlsHost],
      [player, world.playerHandle, cfg.tuneUrlsPlayer1],
    ];
    const total = all.reduce((n, [, , u]) => n + u.length, 0);
    say(`  submitting ${total} tunes across ${all.length} players`);

    // Interleave submissions so neither player's queue dominates.
    for (let i = 0; i < Math.max(...all.map(([, , u]) => u.length)); i++) {
      for (const [api, , urls] of all) {
        const url = urls[i];
        if (url) await api.sendBotDM(world.botHandle, url);
      }
      // Brief pause so the bot's notification loop can drain; not a wait
      // for an acknowledgement.
      await new Promise((r) => setTimeout(r, 1200));
    }

    // Rejections are silent from the submitter's point of view: the bot just
    // does not count the tune. Surface them so a bad URL cannot masquerade as
    // a timing problem.
    const rejects = (await world.playerDmActivity()).filter((s) =>
      /n[aã]o reproduz|invalid|inv[aá]lid/i.test(s.text),
    );
    if (rejects.length > 0) {
      for (const r of rejects) say(`  ! rejected: ${r.text.slice(0, 100)}`);
      throw new Error(
        `${rejects.length} tune(s) rejected as non-reproducible - ` +
          `a player cannot reach ${cfg.playlistLength} tunes, so no poll is possible`,
      );
    }

    // A poll means both playlists registered. The bot may already have
    // resolved it by the time we look, so also accept a game that has moved
    // past the first round - that is the same invariant observed later.
    const poll = await until(
      async () => {
        const pub = await world.botActivity();
        const withPoll = pub.find((s) => s.hasPoll);
        if (withPoll) return withPoll;
        const advanced = pub.find((s) =>
          /rodada|round|campe[aã]o|empate|vencedor|final/i.test(s.text),
        );
        return advanced ?? undefined;
      },
      "bot started the first round (poll or round result)",
      cfg.backstop.submit,
      world,
    );
    return `${total} submitted, 0 rejected, first round ${poll.id}`;
  }, world);

  // ── 4/5. Vote, every round ───────────────────────────────────────────
  //
  // This was a single step OUTSIDE any loop, so the two casts ran once, in
  // round 1, and rounds 2..N resolved with nobody voting:
  //
  //   #1  1002:0  1003:2   <- both sides voted
  //   #2  1002:0  1003:0   <- nobody
  //   #3  1002:0  1003:0
  //
  // The bot read each tally correctly and called them ties, which is right
  // for a round nobody voted in. The harness was the thing under-testing.
  //
  // Two things this loop must get right, both now unit-tested in
  // vote-planner.ts:
  //   - one vote per poll id, or the same poll is re-voted on every pass and
  //     the tally inflates
  //   - stop on a signal (the bot's own finale announcement, or the declared
  //     length played out), not on a fixed count
  await step("vote", async () => {
    const castOn = new Map(
      (Object.entries({ host, challenger: player }) as Array<[string, MastodonAPI]>).map(
        ([label, api]) => [label, api],
      ),
    );
    const votedPolls = new Set<string>();
    const tally: string[] = [];
    let round = 1;

    for (;;) {
      const pub = await world.botActivity();

      // A finale ends the voting whether or not every round was reached.
      const finale = pub.find((s) =>
        /final|encerrad|vencedor|terminou|acabou|🏆|parabéns|parabens/i.test(s.text),
      );
      const open = pub.find((s) => s.hasPoll && s.poll && !s.poll.expired);
      const roundNo = roundsSeen(pub);

      if (!shouldStopVoting({ hasFinale: !!finale, roundNumber: roundNo || round, playlistLength: cfg.playlistLength })) {
        if (finale) {
          say(`  finale announced after ${round - 1} voted round(s)`);
        } else {
          say(`  ${cfg.playlistLength} rounds played out`);
        }
        break;
      }

      // Nothing to vote on yet: the bot is still collecting, or the poll has
      // expired and the next round has not opened.
      if (!open?.poll) {
        await new Promise((r) => setTimeout(r, world.cfg.pollIntervalMs));
        continue;
      }

      const pollId = String(open.poll.id);
      if (alreadyVotedOn(votedPolls, pollId)) {
        // Same poll, already counted. Wait for the next one rather than
        // re-voting: a second cast on the same poll is a wrong tally.
        await new Promise((r) => setTimeout(r, world.cfg.pollIntervalMs));
        continue;
      }

      say(`  round ${round}: poll ${pollId} — ${open.poll.options.map((o) => o.title).join(" vs ")}`);
      const casts = castPlan(open.poll.options.length, 0);
      for (const { label, choice } of casts) {
        const api = castOn.get(label)!;
        const r = await api.votePoll(open.id, pollId, [choice]);
        tally.push(`${label}=${choice}:${r.voters_count ?? "?"}`);
      }
      votedPolls.add(pollId);
      round += 1;

      // Confirm the vote landed: a poll that still reads as readable proves
      // nothing, a poll that reports a voter proves the POST took.
      await until(
        async () => {
          const fresh = await world.botActivity();
          const p = fresh.find((s) => s.hasPoll)?.poll;
          return p && String(p.id) === pollId && (p.voters_count ?? 0) > 0 ? p : undefined;
        },
        `poll ${pollId} tallied`,
        cfg.backstop.poll,
        world,
      );
      say(`  round ${round - 1} voted: ${casts.map((c) => c.label).join(" + ")}`);
    }

    if (tally.length === 0) {
      throw new Error("no poll was ever open to vote on");
    }
    return `${votedPolls.size} round(s) voted: ${tally.join(" ")}`;
  }, world);

  /**
   * The highest round number the bot has announced, or 0 if none yet.
   * "Round 3! Vote for the best tune" -> 3.
   */
  function roundsSeen(pub: Awaited<ReturnType<World["botActivity"]>>): number {
    let high = 0;
    for (const s of pub) {
      for (const m of s.text.matchAll(/(?:round|rodada)\s*#?(\d+)/gi)) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > high) high = n;
      }
    }
    return high;
  }

  // ── 6. Finale ────────────────────────────────────────────────────────
  await step("finale", async () => {
    await until(
      async () => {
        const pub = await world.botActivity();
        return pub.find((s) =>
          /final|encerrad|vencedor|terminou|acabou|🏆|parabéns|parabens/i.test(s.text),
        );
      },
      "bot announced the finale (champion, shared title, or verdict)",
      cfg.backstop.finale,
      world,
    );
    return "finale announced";
  }, world);
}

// ─── Report ────────────────────────────────────────────────────────────

function report() {
  console.log("\n" + "═".repeat(64));
  console.log("  LIFECYCLE RESULT");
  console.log("═".repeat(64));
  for (const r of results) {
    console.log(
      `  ${r.ok ? "✅" : "❌"} ${r.step.padEnd(10)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.detail}`,
    );
  }
  const ok = results.filter((r) => r.ok).length;
  const bad = results.length - ok;
  if (fatal) {
    const why = fatal instanceof Backstop ? `backstop: ${fatal.message}` : String(fatal);
    console.log(`  ❌ aborted    ${why.split("\n")[0]?.slice(0, 60) ?? ""}`);
  }
  console.log("─".repeat(64));
  console.log(`  ${ok} passed, ${bad} failed, total ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log("═".repeat(64));
  // A run that threw is a failure even when no step recorded one. Exiting 0
  // on an empty result list is how a config error looked like a green run.
  process.exit(bad > 0 || fatal ? 1 : 0);
}

/**
 * A run that threw before completing its steps is a failure, even if no
 * step recorded one. LoadConfig throws on a configuration problem - the
 * overlap guard in particular - and that used to exit 0 with an empty
 * result list. Green has to mean the lifecycle ran, not merely that nothing
 * was counted.
 */
let fatal: unknown = null;

main()
  .catch((e) => {
    fatal = e;
    if (!(e instanceof Backstop)) console.error("fatal:", e);
  })
  .finally(() => report());
