import { describe, expect, it } from "vitest";
import { loadConfig, readLogSettings, type BotConfig } from "../src/config.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, migrate } from "../src/db/index.js";

const validEnv: NodeJS.ProcessEnv = {
  MASTODON_URL: "https://mastodon.example",
  MASTODON_TOKEN: "token-abc",
  BOT_ACCT: "playlistbattle",
  POLL_DURATION_SEC: "86400",
  ACCEPTANCE_WINDOW_SEC: "86400",
  SUBMISSION_WINDOW_SEC: "172800",
  CREATION_COOLDOWN_SEC: "600",
  MAX_GAMES_PER_PLAYER: "3",
  AUTO_DELETE_WINDOW_HOURS: "720",
  DB_PATH: "./data/bot.db",
  LOG_LEVEL: "info",
};

function cfg(overrides: NodeJS.ProcessEnv = {}): BotConfig {
  return loadConfig({ ...validEnv, ...overrides });
}

describe("loadConfig", () => {
  it("loads a fully valid environment", () => {
    const c = cfg();
    expect(c.mastodonUrl).toBe("https://mastodon.example");
    expect(c.mastodonToken).toBe("token-abc");
    expect(c.botAcct).toBe("playlistbattle");
    expect(c.pollDurationSec).toBe(86400);
    expect(c.acceptanceWindowSec).toBe(86400);
    expect(c.submissionWindowSec).toBe(172800);
    expect(c.creationCooldownSec).toBe(600);
    expect(c.maxGamesPerPlayer).toBe(3);
    expect(c.autoDeleteWindowHours).toBe(720);
    expect(c.dbPath).toBe("./data/bot.db");
  });

  it("applies documented defaults when optional keys are absent", () => {
    const c = loadConfig({
      MASTODON_URL: validEnv.MASTODON_URL,
      MASTODON_TOKEN: validEnv.MASTODON_TOKEN,
      BOT_ACCT: validEnv.BOT_ACCT,
    });
    expect(c.pollDurationSec).toBe(900); // 15 minutes
    expect(c.acceptanceWindowSec).toBe(86400);
    expect(c.submissionWindowSec).toBe(172800);
    expect(c.creationCooldownSec).toBe(600);
    expect(c.maxGamesPerPlayer).toBe(3);
    expect(c.replacementGraceMin).toBe(15);
    expect(c.earlyCloseEnabled).toBe(true);
    expect(c.earlyCloseMinAgeSec).toBe(300);
    expect(c.earlyCloseStagnationSec).toBe(300);
    expect(c.autoDeleteWindowHours).toBe(0);
    expect(c.dbPath).toBe("./data/bot.db");
    expect(c.locale).toBe("en");
    expect(c.runMode).toBe("production");
    expect(c.notificationIntervalSec).toBe(15);
    expect(c.schedulerIntervalSec).toBe(60);
    expect(c.recoveryIntervalSec).toBe(300);
  });

  it("parses EARLY_CLOSE_ENABLED as a boolean flag", () => {
    expect(cfg({ EARLY_CLOSE_ENABLED: "1" }).earlyCloseEnabled).toBe(true);
    expect(cfg({ EARLY_CLOSE_ENABLED: "0" }).earlyCloseEnabled).toBe(false);
    expect(cfg({ EARLY_CLOSE_ENABLED: "false" }).earlyCloseEnabled).toBe(false);
    expect(cfg({ EARLY_CLOSE_ENABLED: "true" }).earlyCloseEnabled).toBe(true);
  });

  it("normalizes accepted values", () => {
    expect(cfg({ BOT_ACCT: "@playlistbattle" }).botAcct).toBe("playlistbattle");
    expect(cfg({ EARLY_CLOSE_MIN_AGE_SEC: "0" }).earlyCloseMinAgeSec).toBe(0);
    expect(cfg({ LOCALE: "pt-BR" }).locale).toBe("pt-BR");
  });

  it.each([
    ["300", 300],
    ["604800", 604800],
  ])("accepts poll duration %s at Mastodon's 5 min – 7 days bounds", (raw, sec) => {
    expect(cfg({ POLL_DURATION_SEC: raw }).pollDurationSec).toBe(sec);
  });

  it.each<[string, NodeJS.ProcessEnv, RegExp]>([
    ["missing MASTODON_URL", { MASTODON_URL: undefined }, /MASTODON_URL/],
    ["non-https MASTODON_URL", { MASTODON_URL: "http://insecure.example" }, /MASTODON_URL/],
    ["empty MASTODON_TOKEN", { MASTODON_TOKEN: "" }, /MASTODON_TOKEN/],
    ["empty BOT_ACCT", { BOT_ACCT: "" }, /BOT_ACCT/],
    ["BOT_ACCT with a domain (must be local handle)", { BOT_ACCT: "bot@other.example" }, /BOT_ACCT/],
    ["poll duration below 5 min", { POLL_DURATION_SEC: "299" }, /POLL_DURATION_SEC/],
    ["poll duration above 7 days", { POLL_DURATION_SEC: "604801" }, /POLL_DURATION_SEC/],
    // A test mode must NOT be able to create a poll Mastodon will reject.
    ["poll below the 300s floor in test mode", { TEST_MODE: "1", POLL_DURATION_SEC: "30" }, /POLL_DURATION_SEC/],
    ["non-integer POLL_DURATION_SEC", { POLL_DURATION_SEC: "abc" }, /POLL_DURATION_SEC/],
    ["non-integer MAX_GAMES_PER_PLAYER", { MAX_GAMES_PER_PLAYER: "2.5" }, /MAX_GAMES_PER_PLAYER/],
    ["zero acceptance window", { ACCEPTANCE_WINDOW_SEC: "0" }, /ACCEPTANCE_WINDOW_SEC/],
    ["negative submission window", { SUBMISSION_WINDOW_SEC: "-1" }, /SUBMISSION_WINDOW_SEC/],
    ["negative creation cooldown", { CREATION_COOLDOWN_SEC: "-1" }, /CREATION_COOLDOWN_SEC/],
    ["zero concurrent cap", { MAX_GAMES_PER_PLAYER: "0" }, /MAX_GAMES_PER_PLAYER/],
    ["negative early-close min age", { EARLY_CLOSE_MIN_AGE_SEC: "-1" }, /EARLY_CLOSE_MIN_AGE_SEC/],
    ["negative early-close stagnation", { EARLY_CLOSE_STAGNATION_SEC: "-1" }, /EARLY_CLOSE_STAGNATION_SEC/],
    ["unknown log level", { LOG_LEVEL: "verbose" }, /LOG_LEVEL/],
    ["unknown locale", { LOCALE: "fr" }, /LOCALE/],
    ["unknown run mode", { RUN_MODE: "turbo" }, /RUN_MODE/],
  ])("rejects %s", (_case, overrides, error) => {
    expect(() => cfg(overrides)).toThrow(error);
  });

  it("keeps the DB poll_duration_sec constraint in sync with the config minimum", () => {
    // Mastodon rejects polls shorter than 5 minutes, so both the config layer
    // and the SQLite CHECK must agree on 300. If either drifts, game creation
    // fails at runtime with an opaque "CHECK constraint failed" error.
    const dir = mkdtempSync(join(tmpdir(), "pb-poll-floor-"));
    try {
      const db = openDatabase(join(dir, "test.db"));
      migrate(db);
      const floor = cfg({ POLL_DURATION_SEC: "300" });
      const insert = db.prepare(
        `INSERT INTO games
           (id, status, theme, playlist_length, host_account_id, poll_duration_sec, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      expect(() => insert.run(
        "g-ok", "CREATED", "theme", 8, "host", floor.pollDurationSec,
        "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
      )).not.toThrow();
      expect(() => insert.run(
        "g-bad", "CREATED", "theme", 8, "host", floor.pollDurationSec - 1,
        "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
      )).toThrow(/CHECK constraint failed/);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows explicit interval overrides to win over test mode defaults", () => {
    const fast = cfg({ TEST_MODE: "1", NOTIFICATION_INTERVAL_SEC: "2" });
    expect(fast.notificationIntervalSec).toBe(2);
  });

  it("parses LOG_PRETTY as a boolean flag (default off)", () => {
    expect(readLogSettings({}).pretty).toBe(false);
    expect(readLogSettings({ LOG_PRETTY: "1" }).pretty).toBe(true);
    expect(readLogSettings({ LOG_PRETTY: "true" }).pretty).toBe(true);
    expect(readLogSettings({ LOG_PRETTY: "0" }).pretty).toBe(false);
    expect(readLogSettings({ LOG_PRETTY: "false" }).pretty).toBe(false);
  });

  it("reads the boot log level tolerantly, so an invalid one cannot silence startup", () => {
    expect(readLogSettings({}).level).toBe("info");
    expect(readLogSettings({ LOG_LEVEL: "debug" }).level).toBe("debug");
    expect(readLogSettings({ LOG_LEVEL: "verbose" }).level).toBe("info");
    expect(readLogSettings({ LOG_LEVEL: "" }).level).toBe("info");
  });

  it("flags auto-delete as unsafe exactly when the window cannot cover the §2.4 worst case", () => {
    // v1.1 §2.4: acceptance + submission + 12×(poll + replacement) + 2×poll
    const poll = 86400;
    const worstCaseSec = 86400 + 172800 + (poll + 15 * 60) * 12 + poll * 2;
    const windowHours = Math.ceil(worstCaseSec / 3600);
    const at = (hours: number) =>
      cfg({ POLL_DURATION_SEC: String(poll), AUTO_DELETE_WINDOW_HOURS: String(hours) }).autoDeleteUnsafe;
    expect(at(windowHours)).toBe(false);
    expect(at(windowHours - 1)).toBe(true);
  });

  it("does not flag auto-delete when the window is off (0)", () => {
    const c = cfg({ POLL_DURATION_SEC: "604800", AUTO_DELETE_WINDOW_HOURS: "0" });
    expect(c.autoDeleteUnsafe).toBe(false);
  });
});

/**
 * RUN_MODE controls loop cadence and early close. It replaced a TEST_MODE=1
 * that forced the early-close thresholds to 0, silently discarding operator
 * values. "e2e" exists because "test" cannot drive the real Mastodon API:
 * rounds resolve before an outside client can vote.
 */
describe("RUN_MODE", () => {
  it.each(["e2e", "production"])("keeps the operator's early-close thresholds in %s mode", (mode) => {
    const c = cfg({ RUN_MODE: mode, EARLY_CLOSE_MIN_AGE_SEC: "120", EARLY_CLOSE_STAGNATION_SEC: "180" });
    expect(c.earlyCloseMinAgeSec).toBe(120);
    expect(c.earlyCloseStagnationSec).toBe(180);
  });

  it.each<[string, NodeJS.ProcessEnv]>([
    ["RUN_MODE=test", { RUN_MODE: "test" }],
    ["legacy TEST_MODE=1", { TEST_MODE: "1" }],
  ])("%s collapses early-close thresholds to zero, keeping early close enabled", (_case, env) => {
    const c = cfg({ ...env, EARLY_CLOSE_MIN_AGE_SEC: "60", EARLY_CLOSE_STAGNATION_SEC: "60" });
    expect(c.runMode).toBe("test");
    expect(c.earlyCloseEnabled).toBe(true);
    expect(c.earlyCloseMinAgeSec).toBe(0);
    expect(c.earlyCloseStagnationSec).toBe(0);
  });

  it("lets RUN_MODE win over TEST_MODE", () => {
    const c = cfg({ TEST_MODE: "1", RUN_MODE: "e2e", EARLY_CLOSE_MIN_AGE_SEC: "60" });
    expect(c.runMode).toBe("e2e");
    expect(c.earlyCloseMinAgeSec).toBe(60);
  });

  it("uses faster loop cadence outside production", () => {
    const prod = cfg();
    for (const mode of ["e2e", "test"]) {
      const fast = cfg({ RUN_MODE: mode });
      expect(fast.notificationIntervalSec).toBeLessThan(prod.notificationIntervalSec);
      expect(fast.schedulerIntervalSec).toBeLessThan(prod.schedulerIntervalSec);
      expect(fast.recoveryIntervalSec).toBeLessThan(prod.recoveryIntervalSec);
    }
  });
});

/**
 * A bearer token must not cross a network in clear text, but the mock Mastodon
 * listens on http://127.0.0.1. Cleartext http is accepted ONLY for a loopback
 * literal outside production; a non-loopback http URL stays an error in every mode.
 */
describe("MASTODON_URL scheme rules", () => {
  it.each([
    ["http://127.0.0.1:54321", "http://127.0.0.1:54321"],
    ["http://localhost:54321", "http://localhost:54321"],
    ["http://127.0.0.1:54321/", "http://127.0.0.1:54321"],
  ])("accepts loopback %s outside production", (url, expected) => {
    expect(cfg({ MASTODON_URL: url, RUN_MODE: "test" }).mastodonUrl).toBe(expected);
  });

  it.each<[string, string, string | undefined]>([
    ["non-loopback http in test mode", "http://mastodon.social", "test"],
    ["a URL that merely looks loopback", "http://127.0.0.1.evil.com", "test"],
    ["a non-loopback private address in test mode", "http://192.168.68.104:3000", "test"],
    ["loopback http in production", "http://127.0.0.1:54321", "production"],
    ["loopback http when RUN_MODE is unset (production)", "http://127.0.0.1:54321", undefined],
  ])("rejects %s", (_case, url, mode) => {
    expect(() => cfg({ MASTODON_URL: url, RUN_MODE: mode })).toThrow(/MASTODON_URL/);
  });
});
