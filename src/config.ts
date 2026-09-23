import { z } from "zod";
import type { PlaylistPrivacy } from "./youtube/ytmusic.js";

/** Mastodon allows polls from 5 minutes to 7 days. */
const POLL_MIN_SEC = 300;
const POLL_MAX_SEC = 604800;

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

const envSchema = z.object({
  MASTODON_URL: z
    .string()
    .url()
    .startsWith("https://", "must be an https URL"),
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
  EARLY_CLOSE_ENABLED: z
    .string()
    .optional()
    .default("1")
    .transform((v) => v !== "0" && v.toLowerCase() !== "false"),
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

  DB_PATH: z.string().min(1).default("./data/bot.db"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
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
  /** Bot-account YT Music cookie; null → anonymous queue links only. */
  ytCookie: string | null;
  ytAuthUser: number;
  ytPlaylistPrivacy: PlaylistPrivacy;
  dbPath: string;
  logLevel: z.infer<typeof envSchema>["LOG_LEVEL"];
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

  // v1.1 §2.4: acceptance + submission + (N × (poll + replacement)) + scheduling overhead
  const worstCaseGameSec =
    e.ACCEPTANCE_WINDOW_SEC +
    e.SUBMISSION_WINDOW_SEC +
    (e.POLL_DURATION_SEC + e.REPLACEMENT_GRACE_MIN * 60) * MAX_PLAYLIST_LENGTH +
    e.POLL_DURATION_SEC * AUTO_DELETE_MARGIN_POLLS;
  const windowSec = e.AUTO_DELETE_WINDOW_HOURS * 3600;
  // windowSec === 0 means "unknown / no auto-delete" → not flagged as unsafe
  const autoDeleteUnsafe =
    e.AUTO_DELETE_WINDOW_HOURS > 0 && windowSec < worstCaseGameSec;

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
    earlyCloseEnabled: e.EARLY_CLOSE_ENABLED,
    earlyCloseMinAgeSec: e.EARLY_CLOSE_MIN_AGE_SEC,
    earlyCloseStagnationSec: e.EARLY_CLOSE_STAGNATION_SEC,
    autoDeleteWindowHours: e.AUTO_DELETE_WINDOW_HOURS,
    ytCookie: e.YT_COOKIE?.trim() ? e.YT_COOKIE.trim() : null,
    ytAuthUser: e.YT_AUTH_USER,
    ytPlaylistPrivacy: e.YT_PLAYLIST_PRIVACY,
    dbPath: e.DB_PATH,
    logLevel: e.LOG_LEVEL,
    locale: e.LOCALE,
    autoDeleteUnsafe,
  };
}
