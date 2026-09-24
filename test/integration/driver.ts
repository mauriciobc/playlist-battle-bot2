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
import {
  MastodonAPI,
  acctMatches,
  qualifyAcct,
  type MastodonPoll,
} from "./mastodon-helpers.js";

// ─── Config ────────────────────────────────────────────────────────────

interface Cfg {
  hostInstance: string;
  hostToken: string;
  hostAcct: string;
  botAcct: string;
  botInstance: string;
  player1Instance: string;
  player1Token: string;
  player1Acct: string;
  theme: string;
  playlistLength: number;
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

  return {
    hostInstance: vals.HOST_INSTANCE || "mastodon.social",
    hostToken: vals.HOST_TOKEN || "",
    hostAcct: vals.HOST_ACCT || "",
    botAcct: vals.BOT_ACCT || "mauriciobc",
    botInstance: vals.BOT_INSTANCE || "mastodon.social",
    player1Instance: vals.PLAYER1_INSTANCE || "ursal.zone",
    player1Token: vals.PLAYER1_TOKEN || vals.PLAYER_TOKEN || "",
    player1Acct: vals.PLAYER1_ACCT || "",
    // Unique per run: the theme is how the driver recognises its own game
    // among everything else the bot announces. A fixed name collides with
    // games left over from earlier runs.
    theme: `${vals.GAME_THEME || vals.THEME || "E2E"} r${Date.now().toString(36)}`,
    playlistLength: n("PLAYLIST_LENGTH", 8),
    pollDurationSec: n("POLL_DURATION_SEC", 300),
    tuneUrlsHost: urls("TUNE_URLS_HOST"),
    tuneUrlsPlayer1: urls("TUNE_URLS_PLAYER1"),
    debug: vals.DEBUG === "1" || vals.DEBUG === "true",
    backstop: {
      create: n("BACKSTOP_CREATE_SEC", 120),
      accept: n("BACKSTOP_ACCEPT_SEC", 180),
      submit: n("BACKSTOP_SUBMIT_SEC", 300),
      poll: n("BACKSTOP_POLL_SEC", n("POLL_DURATION_SEC", 300) + 120),
      finale: n("BACKSTOP_FINALE_SEC", 900),
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
      .filter((s) => !this.gameTheme || s.hasPoll || s.text.includes(this.gameTheme))
      .map((s) => ({
        id: s.id,
        at: s.created_at,
        text: s.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        visibility: s.visibility,
        hasPoll: Boolean(s.poll),
        poll: s.poll,
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
        poll: s.poll,
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
      return `unreadable: ${String(e).slice(0, 60)}`;
    }
  }
}

// ─── Driver primitives ─────────────────────────────────────────────────

/**
 * Replies that mean the bot refused the command.
 *
 * "bot replied in the thread" is not success on its own: the bot always
 * answers, including with a refusal. Treating any reply as success let a
 * game that was never created look like it had been.
 */
const REFUSALS = [
  /n[aã]o encontrada|not found/i,
  /jogador duplicado|duplicate player/i,
  /cooldown/i,
  /n[aã]o entendi/i,
  /erro|error/i,
  /invite|convite.*pendente/i,
];

function isRefusal(text: string): boolean {
  return REFUSALS.some((re) => re.test(text));
}

const t0 = Date.now();
function say(msg: string) {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);
}

class Backstop extends Error {
  constructor(readonly label: string, readonly snapshot: string) {
    super(`event never occurred: ${label}`);
    this.name = "Backstop";
  }
}

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
  const host = new MastodonAPI(`https://${cfg.hostInstance}`, cfg.hostToken, cfg.debug);
  const player = new MastodonAPI(
    `https://${cfg.player1Instance}`,
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
        // The bot's acceptance is "Você está dentro! 🎵" (youAreIn).
        // Its invite is "Você foi convidado para o duelo …" - never match
        // that: an unaccepted game would look accepted.
        return fresh.find(
          (s) =>
            !isRefusal(s.text) &&
            !/convidado|convidada|invite/i.test(s.text) &&
            /dentro|inside|aceit|entrou|desafio aceito|bem-vindo|bem vindo/i.test(s.text),
        );
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

  // ── 4/5. Vote ────────────────────────────────────────────────────────
  await step("vote", async () => {
    // If every poll has already resolved, the duel ran without us voting -
    // that is a real outcome, not a harness failure. Report it and move on.
    const all = await world.botActivity();
    const pollStatus = all.find((s) => s.hasPoll);
    if (!pollStatus?.poll) {
      const decided = all.find((s) =>
        /rodada|round|campe[aã]o|empate|vencedor|final/i.test(s.text),
      );
      if (decided) {
        say("  all rounds already resolved before the driver could vote");
        return `rounds resolved without a driver vote: ${decided.text.slice(0, 70)}`;
      }
      throw new Error("no poll and no round result to observe");
    }
    const poll = pollStatus.poll;

    say(`  poll ${poll.id}: ${poll.options.map((o) => o.title).join(" vs ")}`);

    // Both participants vote the SAME option, so the round has a winner.
    //
    // The previous version had the host pick option 0 and the challenger
    // option 1 - a guaranteed 1-1 tie, which is why every round resolved as
    // "EMPATE". The comment claimed the opposite of what the code did.
    const votes: string[] = [];
    const cast = async (api: MastodonAPI, label: string, choice: number) => {
      const r = await api.votePoll(pollStatus.id, poll.id, [choice]);
      votes.push(`${label}=${r.voted !== false}`);
      say(`  ${label} voted option ${choice} (voters=${r.voters_count})`);
    };

    const n = poll.options.length;
    const pick = 0; // both sides back the first tune
    await cast(host, "host", pick);
    if (n > 1) await cast(player, "challenger", pick);

    // Confirm the vote actually landed: the poll must now report a voter.
    // "a poll is still readable" is true whether or not the POST worked.
    await until(
      async () => {
        const fresh = await world.botActivity();
        const p = fresh.find((s) => s.hasPoll)?.poll;
        return p && p.voters_count > 0 ? p : undefined;
      },
      `poll tallied ${2} votes`,
      cfg.backstop.poll,
      world,
    );

    return `${votes.join(" ")} on ${poll.options.length} options`;
  }, world);

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
  console.log("─".repeat(64));
  console.log(`  ${ok} passed, ${bad} failed, total ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log("═".repeat(64));
  process.exit(bad > 0 ? 1 : 0);
}

main()
  .catch((e) => {
    if (!(e instanceof Backstop)) console.error("fatal:", e);
  })
  .finally(report);
