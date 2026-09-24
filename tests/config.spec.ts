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
    expect(c.replacementGraceMin).toBe(15);
    expect(c.autoDeleteWindowHours).toBe(720);
    expect(c.dbPath).toBe("./data/bot.db");
  });

  it("applies documented defaults when optional keys are absent", () => {
    const c = cfg({
      POLL_DURATION_SEC: undefined,
      ACCEPTANCE_WINDOW_SEC: undefined,
      SUBMISSION_WINDOW_SEC: undefined,
      CREATION_COOLDOWN_SEC: undefined,
      MAX_GAMES_PER_PLAYER: undefined,
      EARLY_CLOSE_ENABLED: undefined,
      EARLY_CLOSE_MIN_AGE_SEC: undefined,
      EARLY_CLOSE_STAGNATION_SEC: undefined,
      AUTO_DELETE_WINDOW_HOURS: undefined,
      DB_PATH: undefined,
      LOG_LEVEL: undefined,
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
  });

  it("parses EARLY_CLOSE_ENABLED as a boolean flag", () => {
    expect(cfg({ EARLY_CLOSE_ENABLED: "1" }).earlyCloseEnabled).toBe(true);
    expect(cfg({ EARLY_CLOSE_ENABLED: "0" }).earlyCloseEnabled).toBe(false);
    expect(cfg({ EARLY_CLOSE_ENABLED: "false" }).earlyCloseEnabled).toBe(false);
    expect(cfg({ EARLY_CLOSE_ENABLED: "true" }).earlyCloseEnabled).toBe(true);
  });

  it("enforces non-negative early-close windows", () => {
    expect(() => cfg({ EARLY_CLOSE_MIN_AGE_SEC: "-1" })).toThrow(/EARLY_CLOSE_MIN_AGE_SEC/);
    expect(() => cfg({ EARLY_CLOSE_STAGNATION_SEC: "-1" })).toThrow(/EARLY_CLOSE_STAGNATION_SEC/);
    expect(cfg({ EARLY_CLOSE_MIN_AGE_SEC: "0" }).earlyCloseMinAgeSec).toBe(0);
  });

  it("rejects a missing MASTODON_URL", () => {
    expect(() => cfg({ MASTODON_URL: undefined })).toThrow(/MASTODON_URL/);
  });

  it("rejects a non-https MASTODON_URL", () => {
    expect(() => cfg({ MASTODON_URL: "http://insecure.example" })).toThrow(/MASTODON_URL/);
  });

  it("rejects an empty MASTODON_TOKEN", () => {
    expect(() => cfg({ MASTODON_TOKEN: "" })).toThrow(/MASTODON_TOKEN/);
  });

  it("rejects an empty BOT_ACCT", () => {
    expect(() => cfg({ BOT_ACCT: "" })).toThrow(/BOT_ACCT/);
  });

  it("rejects BOT_ACCT containing a domain (must be local handle)", () => {
    expect(() => cfg({ BOT_ACCT: "bot@other.example" })).toThrow(/BOT_ACCT/);
  });

  it("accepts BOT_ACCT with a leading @ and strips it", () => {
    expect(cfg({ BOT_ACCT: "@playlistbattle" }).botAcct).toBe("playlistbattle");
  });

  it("enforces Mastodon poll duration bounds (5 min – 7 days)", () => {
    expect(() => cfg({ POLL_DURATION_SEC: "299" })).toThrow(/POLL_DURATION_SEC/);
    expect(() => cfg({ POLL_DURATION_SEC: "604801" })).toThrow(/POLL_DURATION_SEC/);
    expect(() => cfg({ POLL_DURATION_SEC: "300" })).not.toThrow();
    expect(() => cfg({ POLL_DURATION_SEC: "604800" })).not.toThrow();
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

  it("enforces positive acceptance and submission windows", () => {
    expect(() => cfg({ ACCEPTANCE_WINDOW_SEC: "0" })).toThrow(/ACCEPTANCE_WINDOW_SEC/);
    expect(() => cfg({ SUBMISSION_WINDOW_SEC: "-1" })).toThrow(/SUBMISSION_WINDOW_SEC/);
  });

  it("enforces creation cooldown >= 0 and concurrent cap >= 1", () => {
    expect(() => cfg({ CREATION_COOLDOWN_SEC: "-1" })).toThrow(/CREATION_COOLDOWN_SEC/);
    expect(() => cfg({ MAX_GAMES_PER_PLAYER: "0" })).toThrow(/MAX_GAMES_PER_PLAYER/);
  });

  it("rejects unknown log levels", () => {
    expect(() => cfg({ LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });

  it("parses LOG_PRETTY as a boolean flag (default off)", () => {
    expect(readLogSettings({}).pretty).toBe(false);
    expect(readLogSettings({ LOG_PRETTY: undefined }).pretty).toBe(false);
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

  it("rejects non-integer numeric fields", () => {
    expect(() => cfg({ POLL_DURATION_SEC: "abc" })).toThrow(/POLL_DURATION_SEC/);
    expect(() => cfg({ MAX_GAMES_PER_PLAYER: "2.5" })).toThrow(/MAX_GAMES_PER_PLAYER/);
  });

  it("warns (returned flag) when auto-delete window cannot cover worst-case game length", () => {
    // v1.1 §2.4: acceptance + submission + 12×(poll + replacement) + 2×poll
    const poll = 604800;
    const worstCase = 86400 + 172800 + (poll + 15 * 60) * 12 + poll * 2;
    expect(worstCase).toBeGreaterThan(3600);
    const c = cfg({ POLL_DURATION_SEC: String(poll), AUTO_DELETE_WINDOW_HOURS: "1" });
    expect(c.autoDeleteUnsafe).toBe(true);
  });

  it("marks auto-delete as safe when window covers the exact §2.4 worst case", () => {
    const poll = 86400;
    const worstCaseSec = 86400 + 172800 + (poll + 15 * 60) * 12 + poll * 2;
    const windowHours = Math.ceil(worstCaseSec / 3600);
    const c = cfg({
      POLL_DURATION_SEC: String(poll),
      ACCEPTANCE_WINDOW_SEC: "86400",
      SUBMISSION_WINDOW_SEC: "172800",
      AUTO_DELETE_WINDOW_HOURS: String(windowHours),
    });
    expect(c.autoDeleteUnsafe).toBe(false);

    const oneHourShort = cfg({
      POLL_DURATION_SEC: String(poll),
      ACCEPTANCE_WINDOW_SEC: "86400",
      SUBMISSION_WINDOW_SEC: "172800",
      AUTO_DELETE_WINDOW_HOURS: String(windowHours - 1),
    });
    expect(oneHourShort.autoDeleteUnsafe).toBe(true);
  });

  it("does not flag auto-delete when the window is off (0)", () => {
    const c = cfg({ POLL_DURATION_SEC: "604800", AUTO_DELETE_WINDOW_HOURS: "0" });
    expect(c.autoDeleteUnsafe).toBe(false);
  });
});
