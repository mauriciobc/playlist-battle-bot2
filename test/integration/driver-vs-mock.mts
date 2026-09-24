/**
 * Run the agentic driver against a mock Mastodon started by
 * bot-against-mock.mts, reading the endpoint it wrote.
 *
 * The driver reads test/integration/.env from disk and that file holds real
 * credentials, so it is never modified. Instead the driver is copied into a
 * temp directory - the WHOLE directory, because driver.ts imports
 * ./mastodon-helpers.js and ./driver-exit.js - with a rewritten .env and the
 * ../../src imports made absolute so they still resolve from outside the repo.
 *
 * The bot is a separate process talking to the same mock over HTTP, so this is
 * a genuine two-party conversation: the driver posts a newgame, the bot's
 * notification loop sees it, and the driver reads the bot's replies back.
 */
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

/**
 * Five YouTube ids, split so host and player never hold the same video in a
 * round. Sharing one makes hasRoundCollision() auto-tie the round and skip
 * the poll entirely, which is why so many earlier runs never reached a vote.
 */
/**
 * Sixteen proven YouTube ids.
 *
 * The bot enforces PLAYLIST_LENGTH between 8 and 12, so a five-id pool
 * could never get past creation - it filled at most one round. The driver
 * deals every other video to the host and the rest to the player, so 16
 * ids give 8 each: enough for a legal game, with no shared video in a
 * round (a shared one makes hasRoundCollision auto-tie it).
 */
/**
 * Thirty-two proven YouTube ids, dealt 16 to the host and 16 to the
 * player.
 *
 * loadConfig takes `pool` from TUNE_URLS_HOST and clamps rounds to
 * floor(pool.length / 2) - it reads the HOST list, not the total. Eight
 * per side therefore requested four rounds and the bot refused with
 * "Playlist length must be between 8 and 12". Sixteen on the host gives
 * the eight the bot's minimum requires, and sixteen distinct on the
 * player keeps any round from auto-tieing on a shared video.
 */
const TUNES = [
  "https://www.youtube.com/watch?v=OPf0YbXqDm0",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/watch?v=9bZkp7q19f0",
  "https://www.youtube.com/watch?v=kJQP7kiw5Fk",
  "https://www.youtube.com/watch?v=3JZ_D3ELwOQ",
  "https://www.youtube.com/watch?v=CevxZvSJLk8",
  "https://www.youtube.com/watch?v=YQHsXMglC9A",
  "https://www.youtube.com/watch?v=hT_nvWreIhg",
  "https://www.youtube.com/watch?v=nfWlot6h_JM",
  "https://www.youtube.com/watch?v=09R8_2nJtjg",
  "https://www.youtube.com/watch?v=JGwWNGJdvx8",
  "https://www.youtube.com/watch?v=uelHwf8o7_U",
  "https://www.youtube.com/watch?v=pRpeEdMmmQ0",
  "https://www.youtube.com/watch?v=tVj0ZTS4WF4",
  "https://www.youtube.com/watch?v=450p7goxZqg",
  "https://www.youtube.com/watch?v=ru0K8uYEZWw",
  "https://www.youtube.com/watch?v=L_jWHffIx1E",
  "https://www.youtube.com/watch?v=hTWKbfoikeg",
  "https://www.youtube.com/watch?v=nJb6m0L8v9o",
  "https://www.youtube.com/watch?v=RgKAFK5djrM",
  "https://www.youtube.com/watch?v=hFZFjoX2cGg",
  "https://www.youtube.com/watch?v=60ItHLz5WEA",
  "https://www.youtube.com/watch?v=lp-EO5I60KA",
  "https://www.youtube.com/watch?v=fJ9rUzIMcZQ",
  "https://www.youtube.com/watch?v=Mv6GtxtSlDY",
  "https://www.youtube.com/watch?v=ktvTqknDobU",
  "https://www.youtube.com/watch?v=ZbZSe6N_BXs",
  "https://www.youtube.com/watch?v=y6120QOlsfU",
  "https://www.youtube.com/watch?v=Bjft7mr9okw",
  "https://www.youtube.com/watch?v=CevxZvSJLk0",
  "https://www.youtube.com/watch?v=OU3FV5cM8GA",
  "https://www.youtube.com/watch?v=e-ORhEE9VVg",
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
  const endpointFile = resolve(HERE, ".mock-endpoint");
  if (!existsSync(endpointFile)) {
    console.error(
      "No .mock-endpoint found. Start the mock and bot first:\n" +
        "  npx tsx test/integration/bot-against-mock.mts",
    );
    process.exit(2);
  }
  const endpoint: Record<string, string> = {};
  for (const line of readFileSync(endpointFile, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || !t.includes("=")) continue;
    const i = t.indexOf("=");
    endpoint[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  const baseUrl = endpoint.MOCK_URL;
  if (!baseUrl) {
    console.error(".mock-endpoint carries no MOCK_URL");
    process.exit(2);
  }
  console.log(`driver -> ${baseUrl}`);

  const stage = mkdtempSync(join(tmpdir(), "pbb-mock-"));
  cpSync(HERE, stage, {
    recursive: true,
    filter: (src) => !src.endsWith("/.env") && !src.endsWith("node_modules"),
  });
  const driverStage = join(stage, "driver.ts");
  const srcPath = join(REPO, "src").replace(/\\/g, "/");
  writeFileSync(
    driverStage,
    readFileSync(driverStage, "utf-8").replace(
      /from "\.\.\/\.\.\/src\//g,
      `from "${srcPath}/`,
    ),
  );

  const vals = readEnvFile(join(HERE, ".env"));
  vals.HOST_API_URL = baseUrl;
  vals.PLAYER1_API_URL = baseUrl;
  vals.BOT_API_URL = baseUrl;
  vals.HOST_INSTANCE = "mock.social";
  vals.BOT_INSTANCE = "mock.social";
  vals.PLAYER1_INSTANCE = "mock.social";
  vals.HOST_ACCT = "host";
  vals.BOT_ACCT = "bot";
  vals.PLAYER1_ACCT = "player";
  // A token per role. Sharing one made player.getMe() return the bot, so the
  // host and the challenger resolved to the same account and the bot
  // refused the game as a duplicate player.
  vals.HOST_TOKEN = endpoint.MOCK_HOST_TOKEN ?? "host-token";
  vals.PLAYER1_TOKEN = endpoint.MOCK_PLAYER_TOKEN ?? "player-token";
  // The third voter, cast from the player's token - the mock treats any
  // bearer as its own account, and the point is the ROUTE, not the identity.
  // A dedicated account keeps the tally readable in the bot's database.
  vals.VOTER1_TOKEN = endpoint.MOCK_VOTER_TOKEN ?? "voter-token";
  vals.VOTER1_ACCT = "voter@mock.social";

  // The driver deals a single pool alternately (even -> host, odd -> player)
  // and clamps rounds to floor(pool.length / 2). Handing it one pool of 16
  // yields 8 rounds, the bot's minimum. Handing it pre-split 8 + 8 yields
  // floor(8/2) = 4, which the bot rejects - the clamp is right, the split was
  // the mistake.
  // Split the pool here, so each side gets 8 distinct videos and the
  // driver's floor(pool / 2) clamp lands on 8 - the bot's minimum. The driver
  // refuses a shared video outright (hasRoundCollision would auto-tie the
  // round), so the two lists must not overlap.
  //
  // TUNE_URLS_PLAYER1 is deleted, not blanked: split("") yields [""], which
  // is a non-empty list and makes the driver hand the whole pool to both.
  const half = Math.floor(TUNES.length / 2);
  vals.TUNE_URLS_HOST = TUNES.slice(0, half).join(",");
  vals.TUNE_URLS_PLAYER1 = TUNES.slice(half).join(",");
  vals.PLAYLIST_LENGTH = String(half);
  vals.POLL_DURATION_SEC = "300";
  vals.DEBUG = "1";

  const envPath = join(stage, ".env");
  writeFileSync(envPath, Object.entries(vals).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  chmodSync(envPath, 0o600);

  const child = spawn("npx", ["tsx", "driver.ts"], {
    cwd: stage,
    stdio: ["ignore", "inherit", "inherit"],
  });
  const code = await new Promise<number>((res) => {
    child.on("exit", (c) => res(c ?? 1));
  });
  console.log(`\ndriver exit: ${code}`);
  process.exit(code);
}

void main();
