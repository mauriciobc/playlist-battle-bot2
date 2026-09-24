/**
 * Start the mock Mastodon and the real bot in one process, and keep serving.
 *
 * The earlier version spawned src/index.ts as a child, and the child's
 * timers never fired - the log stopped at "bot running" and the bot made no
 * request to the mock for four minutes. In-process it is healthy: a
 * diagnostic run showed 9 notification polls in 40s, one every 5s, exactly
 * the RUN_MODE=e2e cadence. Nothing about the bot was wrong; the spawn was.
 *
 * So: import the bot's entrypoint here, let it own its own timers, and have
 * the mock's HTTP server listen in the same event loop.
 *
 *   terminal 1: npx tsx test/integration/bot-against-mock.mts
 *   terminal 2: npx tsx test/integration/driver-vs-mock.mts
 *
 * The endpoint is written to .mock-endpoint so the second shell needs no
 * copy-paste.
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MockMastodonServer } from "./mock-mastodon.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const server = new MockMastodonServer({
  botAcct: "bot@mock.social",
  hostAcct: "host@mock.social",
  playerAcct: "player@mock.social",
  // Bind all interfaces: a Dockerised bot cannot reach the host's 127.0.0.1.
  host: "0.0.0.0",
});
await server.start();

const url = server.baseUrl;
writeFileSync(resolve(HERE, ".mock-endpoint"), `${url}\n${server.token}\n`);
console.log(`mock Mastodon listening on ${url}`);
console.log("run the driver with: npx tsx test/integration/driver-vs-mock.mts\n");

Object.assign(process.env, {
  MASTODON_URL: url,
  MASTODON_TOKEN: server.token,
  BOT_ACCT: "bot",
  RUN_MODE: "e2e",
  TEST_MODE: "0",
  POLL_DURATION_SEC: "300",
  DB_PATH: "/tmp/pbb-mock-bot.db",
  LOG_LEVEL: "info",
  LOG_PRETTY: "0",
  EARLY_CLOSE_MIN_AGE_SEC: "120",
  EARLY_CLOSE_STAGNATION_SEC: "120",
});

// The bot's own main() installs its intervals and returns; this keeps serving.
await import("../../src/index.js");
