import { z } from "zod";
import type { PlaylistPrivacy } from "./youtube/ytmusic.js";

/** Mastodon allows polls from 5 minutes to 7 days. */
const POLL_MIN_SEC = 300;
const POLL_MAX_SEC = 604800;

/** Operating mode. See RUN_MODE. */
type RunMode = "production" | "e2e" | "test";

/**
 * Loop cadence (seconds) per mode. The poll itself stays >= 300s in every
 * mode because Mastodon rejects shorter polls; test modes shorten rounds by
 * resolving stagnant polls early. E2E is fast enough to keep a suite moving,
 * slow enough that an external client can read a poll and vote before the
 * round is resolved underneath it.
 */
const LOOP_CADENCE_SEC: Record<RunMode, { notification: number; scheduler: number; recovery: number }> = {
  production: { notification: 15, scheduler: 60, recovery: 300 },
  e2e: { notification: 5, scheduler: 10, recovery: 30 },
  test: { notification: 5, scheduler: 10, recovery: 60 },
};

const intFromEnv = (min: number, max?: number) =>
  z
    .string()
    .regex(/^\d+$/, "must be a non-negative integer")
    .transform(Number)
    .pipe(
      max === undefined
        ? z.number().int().min(min)
        : z.number().int().min(min).max(max),
    );

/** Log levels pino accepts; single source for schema validation and boot. */
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

/**
 * Boolean env flag: "0"/"false" off, anything else on. The boot reader below
 * parses LOG_PRETTY through this same schema, so it cannot mean two things.
 */
const envFlag = (fallback: "0" | "1") =>
  z
    .string()
    .optional()
    .default(fallback)
    .transform((value) => value !== "0" && value.toLowerCase() !== "false");

/**
 * Log settings for the boot identity line. Deliberately tolerant: it runs
 * before `loadConfig`, so a malformed LOG_LEVEL must fall back to "info"
 * rather than throw or silence the line that identifies the running build.
 */
export function readLogSettings(env: NodeJS.ProcessEnv = process.env): {
  level: (typeof LOG_LEVELS)[number];
  pretty: boolean;
} {
  return {
    level: LOG_LEVELS.find((candidate) => candidate === env.LOG_LEVEL) ?? "info",
    pretty: envFlag("0").parse(env.LOG_PRETTY),
  };
}

/**
 * The transport rule, applied after the schema parses so it can see RUN_MODE.
 *
 * The bearer token must not cross a network in clear text, so https is always
 * required — except for a loopback literal (not 127.0.0.1.evil.com, not a LAN
 * address) outside production: the mock Mastodon the e2e harness runs against
 * listens on 127.0.0.1.
 */
function assertMastodonTransport(url: string, mode: RunMode): void {
  if (url.startsWith("https://")) return;
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    // Unparsable → not loopback.
  }
  const cleartextOk =
    !url.startsWith("http://") ||
    (mode !== "production" && ["127.0.0.1", "localhost", "::1"].includes(hostname));
  if (!cleartextOk) {
    throw new Error(
      "Invalid configuration: MASTODON_URL: must be an https URL (cleartext " +
        "http is allowed only for a loopback host, and never in production)",
    );
  }
}

const envSchema = z.object({
  MASTODON_URL: z.string().url(),
  MASTODON_TOKEN: z.string().min(1, "required"),
  BOT_ACCT: z
    .string()
    .min(1, "required")
    .transform((v) => v.replace(/^@/, ""))
    .refine((v) => !v.includes("@"), "must be a local handle without domain"),

  // NOTE: Zod .default() short-circuits to the output side of the pipeline,
  // so defaults here are numbers (post-transform output type).
  POLL_DURATION_SEC: intFromEnv(POLL_MIN_SEC, POLL_MAX_SEC).default(900),
  ACCEPTANCE_WINDOW_SEC: intFromEnv(1).default(86400),
  SUBMISSION_WINDOW_SEC: intFromEnv(1).default(172800),

  CREATION_COOLDOWN_SEC: intFromEnv(0).default(600),
  MAX_GAMES_PER_PLAYER: intFromEnv(1).default(3),

  // v1.1 1.4: replacement window for unavailable round tunes (minutes).
  REPLACEMENT_GRACE_MIN: intFromEnv(1).default(15),

  // Stagnation early close: resolve a still-open poll before Mastodon expires
  // it once votes stop changing (requires visible tallies, i.e. hide_totals off).
  EARLY_CLOSE_ENABLED: envFlag("1"),
  EARLY_CLOSE_MIN_AGE_SEC: intFromEnv(0).default(300),
  EARLY_CLOSE_STAGNATION_SEC: intFromEnv(0).default(300),

  AUTO_DELETE_WINDOW_HOURS: intFromEnv(0).default(0),

  /**
   * Optional bot-account YouTube Music session cookie. When set, the finale
   * also publishes a real playlist to that account; without it the finale
   * falls back to an anonymous YouTube queue link.
   */
  YT_COOKIE: z.string().optional(),
  YT_AUTH_USER: intFromEnv(0).default(0),
  YT_PLAYLIST_PRIVACY: z.enum(["PUBLIC", "PRIVATE", "UNLISTED"]).default("PUBLIC"),

  /**
   * Operating mode.
   *
   * - "production": full cadence, poll closes on its own terms.
   * - "e2e":        fast loops, but a poll stays open long enough for a real
   *                 client to read it and vote. This is the mode the E2E
   *                 driver needs; "test" is not enough because it collapses
   *                 the early-close thresholds to zero.
   * - "test":       everything collapses to zero, so a whole game finishes in
   *                 seconds. Fine for the bot's own unit tests, useless for
   *                 driving the real Mastodon API from outside.
   *
   * Modes control loop cadence and early close, never the poll floor.
   */
  RUN_MODE: z.enum(["production", "e2e", "test"]).optional(),

  // Legacy spelling still set in existing deployments' env files:
  // TEST_MODE=1 (with no RUN_MODE) means RUN_MODE="test".
  TEST_MODE: envFlag("0"),

  NOTIFICATION_INTERVAL_SEC: intFromEnv(1).optional(),
  SCHEDULER_INTERVAL_SEC: intFromEnv(1).optional(),
  RECOVERY_INTERVAL_SEC: intFromEnv(1).optional(),

  DB_PATH: z.string().min(1).default("./data/bot.db"),
  // Validated so a typo fails the boot loudly; readLogSettings() reads the same
  // values tolerantly, before validation, for the build-identity line.
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  // Human-readable colorized logs (needs pino-pretty; JSON fallback otherwise).
  LOG_PRETTY: envFlag("0"),
  LOCALE: z.enum(["en", "pt-BR"]).default("en"),
});

export type BotConfig = {
  mastodonUrl: string;
  mastodonToken: string;
  botAcct: string;
  pollDurationSec: number;
  acceptanceWindowSec: number;
  submissionWindowSec: number;
  creationCooldownSec: number;
  maxGamesPerPlayer: number;
  replacementGraceMin: number;
  earlyCloseEnabled: boolean;
  earlyCloseMinAgeSec: number;
  earlyCloseStagnationSec: number;
  autoDeleteWindowHours: number;
  /** Effective operating mode. TEST_MODE is folded in at load time. */
  runMode: RunMode;
  /** Loop cadences in seconds. */
  notificationIntervalSec: number;
  schedulerIntervalSec: number;
  recoveryIntervalSec: number;
  /** Bot-account YT Music cookie; null → anonymous queue links only. */
  ytCookie: string | null;
  ytAuthUser: number;
  ytPlaylistPrivacy: PlaylistPrivacy;
  dbPath: string;
  locale: z.infer<typeof envSchema>["LOCALE"];
  /**
   * True when the configured auto-delete window cannot comfortably cover the
   * worst-case game duration: acceptance + submission + (N × (poll + replacement)) + scheduling
   * overhead. PRD §2.7 / §8; v1.1 §2.4 formula.
   */
  autoDeleteUnsafe: boolean;
};

/** Worst-case rounds = max playlist length; margin = 2 extra poll durations (scheduling overhead). */
const MAX_PLAYLIST_LENGTH = 12;
const AUTO_DELETE_MARGIN_POLLS = 2;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BotConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${details}`);
  }
  const e = parsed.data;

  // RUN_MODE is authoritative. TEST_MODE is kept for existing deployments:
  // TEST_MODE=1 with no RUN_MODE means "test", which preserves the old
  // zeroed-threshold behaviour exactly.
  const runMode: RunMode = e.RUN_MODE ?? (e.TEST_MODE ? "test" : "production");

  // Cross-field check, deliberately AFTER runMode is resolved: an unset
  // RUN_MODE means production, and reading the raw value would let cleartext
  // loopback through by default.
  assertMastodonTransport(e.MASTODON_URL, runMode);
  const isTest = runMode === "test";

  // v1.1 §2.4: acceptance + submission + (N × (poll + replacement)) + scheduling overhead
  const worstCaseGameSec =
    e.ACCEPTANCE_WINDOW_SEC +
    e.SUBMISSION_WINDOW_SEC +
    (e.POLL_DURATION_SEC + e.REPLACEMENT_GRACE_MIN * 60) * MAX_PLAYLIST_LENGTH +
    e.POLL_DURATION_SEC * AUTO_DELETE_MARGIN_POLLS;
  const cadence = LOOP_CADENCE_SEC[runMode];

  return {
    mastodonUrl: e.MASTODON_URL.replace(/\/+$/, ""),
    mastodonToken: e.MASTODON_TOKEN,
    botAcct: e.BOT_ACCT,
    pollDurationSec: e.POLL_DURATION_SEC,
    acceptanceWindowSec: e.ACCEPTANCE_WINDOW_SEC,
    submissionWindowSec: e.SUBMISSION_WINDOW_SEC,
    creationCooldownSec: e.CREATION_COOLDOWN_SEC,
    maxGamesPerPlayer: e.MAX_GAMES_PER_PLAYER,
    replacementGraceMin: e.REPLACEMENT_GRACE_MIN,
    // EARLY_CLOSE_ENABLED stays operator-controlled in every mode. Only "test"
    // collapses the thresholds to zero; in "e2e" and "production" the
    // operator's values are used as given, so a client has a real window to
    // read a poll and vote.
    earlyCloseEnabled: e.EARLY_CLOSE_ENABLED,
    earlyCloseMinAgeSec: isTest ? 0 : e.EARLY_CLOSE_MIN_AGE_SEC,
    earlyCloseStagnationSec: isTest ? 0 : e.EARLY_CLOSE_STAGNATION_SEC,
    autoDeleteWindowHours: e.AUTO_DELETE_WINDOW_HOURS,
    runMode,
    notificationIntervalSec: e.NOTIFICATION_INTERVAL_SEC ?? cadence.notification,
    schedulerIntervalSec: e.SCHEDULER_INTERVAL_SEC ?? cadence.scheduler,
    recoveryIntervalSec: e.RECOVERY_INTERVAL_SEC ?? cadence.recovery,
    ytCookie: e.YT_COOKIE?.trim() || null,
    ytAuthUser: e.YT_AUTH_USER,
    ytPlaylistPrivacy: e.YT_PLAYLIST_PRIVACY,
    dbPath: e.DB_PATH,
    locale: e.LOCALE,
    // 0 means "unknown / no auto-delete" → never flagged as unsafe
    autoDeleteUnsafe:
      e.AUTO_DELETE_WINDOW_HOURS > 0 && e.AUTO_DELETE_WINDOW_HOURS * 3600 < worstCaseGameSec,
  };
}
