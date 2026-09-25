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
 * copy-paste. When the bot exits (Ctrl-C), the mock prints what actually
 * reached it - statuses, polls and per-option tallies - as evidence the
 * driver's own report cannot fake.
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
// A token per account. Sharing the bot's token across roles makes
// player.getMe() return the bot, and the driver then posts a newgame whose
// host and challenger are the same account - refused as a duplicate.
server.registerToken("host-token", "host@mock.social");
server.registerToken("player-token", "player@mock.social");
// A third voter. ROUND_QUORUM is 3 (src/game/scoring.ts), so a round with
// only the two players voting ties by rule - resolveRoundScore returns
// winnerAccountId null when totalVotes < ROUND_QUORUM, and the bot was
// correct to call those ties. The bot cannot be the third voter: it owns the
// poll. A spectator account is the honest way to reach quorum through the
// same POST /polls/:id/votes route everything else uses.
server.registerToken("voter-token", "voter@mock.social");
await server.start();

const url = server.baseUrl;
writeFileSync(
  resolve(HERE, ".mock-endpoint"),
  [
    `MOCK_URL=${url}`,
    `MOCK_BOT_TOKEN=${server.token}`,
    `MOCK_HOST_TOKEN=host-token`,
    `MOCK_PLAYER_TOKEN=player-token`,
    `MOCK_VOTER_TOKEN=voter-token`,
    "",
  ].join("\n"),
);
console.log(`mock Mastodon listening on ${url}`);
console.log("run the driver with: npx tsx test/integration/driver-vs-mock.mts\n");

process.on("exit", () => {
  const { state } = server;
  const polls = [...state.polls.values()].map((poll) => ({ poll, tally: state.tally(poll) }));
  const votes = polls.reduce((n, { tally }) => n + tally.reduce((a, b) => a + b, 0), 0);
  console.log("\n--- mock evidence ---");
  console.log(`statuses created: ${state.statuses.size}`);
  console.log(`polls created:    ${polls.length}`);
  console.log(`votes cast:       ${votes}`);
  for (const { poll, tally } of polls) {
    const options = poll.options.map((title, i) => `${title}=${tally[i]}`).join("  ");
    console.log(`  poll ${poll.id}: ${options}  expired=${state.pollExpired(poll)}`);
  }
});

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
  // A 600s creation cooldown carries over between runs and makes every
  // subsequent run refuse before creating anything. Each run starts a fresh
  // bot, so the cooldown has nothing to protect here.
  CREATION_COOLDOWN_SEC: "0",
  MAX_GAMES_PER_PLAYER: "99",
});

// The bot's own main() installs its intervals and returns; this keeps serving.
await import("../../src/index.js");
