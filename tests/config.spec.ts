import { describe, expect, it } from "vitest";
import { loadConfig, type BotConfig } from "../src/config.js";

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
    expect(c.logLevel).toBe("info");
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
    expect(c.logLevel).toBe("info");
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
