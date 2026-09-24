/**
 * Run the full driver lifecycle against the mock Mastodon, in one process.
 *
 * Why: the live runs kept failing at `create` because mastodon.social
 * throttles status posting far more tightly than its documented
 * 300-per-5-minutes reading limit. Runs 15, 16 and 17 all died there, with
 * GET notifications still reporting 299 of 300 remaining. No cooldown cleared
 * it, so the harness needs a target it can actually post to.
 *
 * The bot itself is a separate process - it has its own config and DB. Point
 * it at this mock with BOT_BASE_URL and it will talk to the same server:
 *
 *   npx tsx test/integration/run-against-mock.ts      # prints the URL
 *   BOT_BASE_URL=<that URL> RUN_MODE=e2e ... (the bot)
 *
 * The driver reads test/integration/.env from disk - not process.env - and
 * that file holds real credentials, so it is never modified here. Instead the
 * driver is copied into a temp working directory alongside a rewritten .env,
 * with the ../../src import path adjusted. The bot under test is the real
 * code; only the server is fake.
 */

import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MockMastodonServer } from "./mock-mastodon.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

const BOT_ACCT = "bot@mock.social";
const HOST_ACCT = "host@mock.social";
const PLAYER_ACCT = "player@mock.social";
const DOMAIN = "mock.social";

/**
 * Five proven YouTube ids, split so host and player never hold the same video
 * in a round. Sharing one makes hasRoundCollision() (src/game/types.ts) treat
 * the round as a tie and skip the poll entirely, which is why so many earlier
 * runs auto-tied in seconds and never reached a vote.
 */
const TUNES = [
  "https://www.youtube.com/watch?v=OPf0YbXqDm0",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/watch?v=9bZkp7q19f0",
  "https://www.youtube.com/watch?v=kJQP7kiw5Fk",
  "https://www.youtube.com/watch?v=3JZ_D3ELwOQ",
];

function readEnvFile(path: string): Record<string, string> {
  const vals: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    vals[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return vals;
}

async function main(): Promise<void> {
  const server = new MockMastodonServer({
    botAcct: BOT_ACCT,
    hostAcct: HOST_ACCT,
    playerAcct: PLAYER_ACCT,
  });
  await server.start();
  console.log(`mock Mastodon listening on ${server.baseUrl}`);
  console.log("  point the bot at it with:");
  console.log(`    MASTODON_URL=${server.baseUrl} MASTODON_TOKEN=${server.token} \\`);
  console.log(`    BOT_ACCT=bot RUN_MODE=e2e DB_PATH=/tmp/pbb-mock.db \\`);
  console.log(`    MASTODON_URL=${server.baseUrl} npm start`);

  // Stage a working copy of the driver with a .env pointed at the mock, so
  // the real credentials file is never touched.
  const stage = mkdtempSync(join(tmpdir(), "pbb-mock-"));
  const driverSrc = join(HERE, "driver.ts");
  const driverStage = join(stage, "driver.ts");
  // The staged copy lives outside the repo, so rewrite the relative import
  // of ../../src/... into an absolute one that still resolves.
  const code = readFileSync(driverSrc, "utf-8").replace(
    /from "\.\.\/\.\.\/src\//g,
    `from "${join(REPO, "src").replace(/\\/g, "/")}/`,
  );
  writeFileSync(driverStage, code);

  const vals = readEnvFile(join(HERE, ".env"));
  vals.HOST_API_URL = server.baseUrl;
  vals.PLAYER1_API_URL = server.baseUrl;
  vals.BOT_API_URL = server.baseUrl;
  vals.HOST_INSTANCE = DOMAIN;
  vals.BOT_INSTANCE = DOMAIN;
  vals.PLAYER1_INSTANCE = DOMAIN;
  vals.HOST_ACCT = "host";
  vals.BOT_ACCT = "bot";
  vals.PLAYER1_ACCT = "player";
  vals.HOST_TOKEN = server.token;
  vals.PLAYER1_TOKEN = server.token;

  const half = Math.floor(TUNES.length / 2);
  vals.TUNE_URLS_HOST = TUNES.slice(0, half).join(",");
  vals.TUNE_URLS_PLAYER1 = TUNES.slice(half).join(",");
  vals.PLAYLIST_LENGTH = String(half);
  vals.POLL_DURATION_SEC = "300";
  vals.DEBUG = "1";

  const envPath = join(stage, ".env");
  writeFileSync(envPath, Object.entries(vals).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  chmodSync(envPath, 0o600);

  console.log(`\nrunning driver from ${stage}\n`);
  const child = spawn("npx", ["tsx", driverStage], {
    cwd: stage,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const code2 = await new Promise<number>((res) => {
    child.on("exit", (c) => res(c ?? 1));
  });

  // Evidence the run cannot fake for itself.
  const { state } = server;
  const polls = [...state.polls.values()];
  const voteCount = polls.reduce(
    (n, p) => n + [...p.votes.values()].reduce((m, c) => m + c.length, 0),
    0,
  );
  console.log("\n--- mock evidence ---");
  console.log(`statuses created: ${state.statuses.size}`);
  console.log(`polls created:    ${polls.length}`);
  console.log(`votes cast:       ${voteCount}`);
  for (const poll of polls) {
    const tallies = new Array<number>(poll.options.length).fill(0);
    for (const choices of poll.votes.values()) {
      for (const c of choices) if (typeof tallies[c] === "number") tallies[c] += 1;
    }
    console.log(
      `  poll ${poll.id}: ${poll.options
        .map((t, i) => `${t}=${tallies[i]}`)
        .join("  ")}  expired=${state.pollExpired(poll)}`,
    );
  }

  await server.stop();
  console.log(`\ndriver exit: ${code2}`);
  process.exit(code2);
}

void main();
