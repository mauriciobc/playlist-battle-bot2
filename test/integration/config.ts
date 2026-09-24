/**
 * Integration test configuration.
 *
 * Required env vars:
 *   MASTODON_URL        – e.g. https://mastodon.social
 *   BOT_ACCT            – bot handle WITHOUT @, e.g. playlistbattle
 *   HOST_TOKEN          – access token for the host account
 *   PLAYER1_TOKEN       – access token for player 1
 *   PLAYER2_TOKEN       – (optional) access token for player 2
 *   HOST_ACCT           – host account handle WITHOUT @
 *   PLAYER1_ACCT        – player 1 handle WITHOUT @
 *   PLAYER2_ACCT        – (optional) player 2 handle WITHOUT @
 *
 * Optional:
 *   GAME_THEME          – override default theme (default: "integration test")
 *   PLAYLIST_LENGTH     – override playlist length (default: 8, min 8)
 *   POLL_DURATION_SEC   – poll duration in seconds (default 300; Mastodon minimum)
 *   TUNE_URLS_PLAYER1   – comma-separated YouTube URLs for player 1 (otherwise uses test stubs)
 *   TUNE_URLS_PLAYER2   – comma-separated YouTube URLs for player 2
 *   WAIT_TIMEOUT_SEC    – max seconds to wait for bot response (default: 420)
 *   POLL_CHECK_INTERVAL_SEC – seconds between API polls while waiting (default: 5)
 *   FINALE_TIMEOUT_SEC – max seconds to wait for the finale (default: 1800)
 *   DEBUG               – set to "1" for verbose logging
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env from the integration test directory
try {
  const envPath = resolve(import.meta.dirname || ".", ".env");
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // .env not found — rely on environment
}

export interface TestConfig {
  botInstance: string;
  botAcct: string;
  hostToken: string;
  hostInstance: string;
  player1Token: string;
  player1Instance: string;
  player2Token: string | null;
  player2Instance: string | null;
  hostAcct: string;
  player1Acct: string;
  player2Acct: string | null;
  theme: string;
  playlistLength: number;
  pollDurationSec: number;
  tuneUrlsHost: string[];
  tuneUrlsPlayer1: string[];
  tuneUrlsPlayer2: string[];
  waitTimeoutSec: number;
  pollWaitSec: number;
  pollCheckIntervalSec: number;
  finaleTimeoutSec: number;
  debug: boolean;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function opt(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function optInt(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number(v) : fallback;
}

/** Well-known public YouTube videos for testing (verified available). */
const TEST_TUNES_P1 = [
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/watch?v=9bZkp7q19f0",
  "https://www.youtube.com/watch?v=JGwWNGJdvx8",
  "https://www.youtube.com/watch?v=kJQP7kiw5Fk",
  "https://www.youtube.com/watch?v=RgKAFK5djSk",
  "https://www.youtube.com/watch?v=lp-EO5I60KA",
  "https://www.youtube.com/watch?v=renskof85",
  "https://www.youtube.com/watch?v=fJ9rUzIMcZQ",
];

const TEST_TUNES_P2 = [
  "https://www.youtube.com/watch?v=OPf0YbXqDm0",
  "https://www.youtube.com/watch?v=09R8_2nJtjg",
  "https://www.youtube.com/watch?v=YQHsXMglC9A",
  "https://www.youtube.com/watch?v=60ItHLz5WEA",
  "https://www.youtube.com/watch?v=3JZ_D3ELwOQ",
  "https://www.youtube.com/watch?v=uelHwf8o7_U",
  "https://www.youtube.com/watch?v=2Vv-BfVoq4g",
  "https://www.youtube.com/watch?v=hT_nvWreIhg",
];

/**
 * Parse a comma-separated URL list from the environment, falling back to
 * `fallback` when unset or empty.
 *
 * The obvious `list.filter(Boolean) || fallback` does NOT work: an empty
 * array is truthy, so the fallback never fired and the test submitted 0 tunes.
 */
function envUrls(name: string, fallback: string[], length: number): string[] {
  const raw = (process.env[name] || "").split(",").filter(Boolean);
  return (raw.length > 0 ? raw : fallback).slice(0, length);
}

export function loadConfig(): TestConfig {
  const p2Token = process.env.PLAYER2_TOKEN || null;
  const p2Acct = process.env.PLAYER2_ACCT || null;
  const p2Instance = process.env.PLAYER2_INSTANCE || null;
  const length = Math.max(8, optInt("PLAYLIST_LENGTH", 8));

  return {
    botInstance: req("BOT_INSTANCE"),
    botAcct: req("BOT_ACCT"),
    hostToken: req("HOST_TOKEN"),
    hostInstance: req("HOST_INSTANCE"),
    player1Token: req("PLAYER1_TOKEN"),
    player1Instance: req("PLAYER1_INSTANCE"),
    player2Token: p2Token,
    player2Instance: p2Instance,
    hostAcct: req("HOST_ACCT"),
    player1Acct: req("PLAYER1_ACCT"),
    player2Acct: p2Acct,
    theme: opt("GAME_THEME", "integration test"),
    playlistLength: length,
    pollDurationSec: optInt("POLL_DURATION_SEC", 300),
    tuneUrlsHost: envUrls("TUNE_URLS_HOST", TEST_TUNES_P2, length),
    tuneUrlsPlayer1: envUrls("TUNE_URLS_PLAYER1", TEST_TUNES_P1, length),
    tuneUrlsPlayer2: envUrls("TUNE_URLS_PLAYER2", TEST_TUNES_P2, length),
    waitTimeoutSec: optInt("WAIT_TIMEOUT_SEC", 420),
    pollWaitSec: optInt("POLL_WAIT_SEC", 305),
    pollCheckIntervalSec: optInt("POLL_CHECK_INTERVAL_SEC", 5),
    finaleTimeoutSec: optInt("FINALE_TIMEOUT_SEC", 1800),
    debug: opt("DEBUG", "") === "1",
  };
}
