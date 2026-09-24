#!/usr/bin/env node
/**
 * Playlist Battle Bot — Live Integration Test Runner
 *
 * Drives a full game lifecycle against a real Mastodon instance:
 *   1. Host creates a game
 *   2. Players accept invites via DM
 *   3. Players submit tunes via DM
 *   4. Bot posts poll rounds
 *   5. Players vote on polls
 *   6. Bot announces finale
 *
 * Usage:
 *   cp .env.example .env    # fill in tokens
 *   npx tsx test/integration/run.ts
 *
 * Required env vars: see config.ts
 */

import { loadConfig, type TestConfig } from "./config.js";
import { MastodonAPI, waitForBotReply, waitForBotPoll, waitForBotFinale, waitFor, sleep, type MastodonStatus } from "./mastodon-helpers.js";

// ─── Test state ──────────────────────────────────────────────

interface TestState {
  hostApi: MastodonAPI;
  player1Api: MastodonAPI;
  player2Api: MastodonAPI | null;
  botAcct: string;
  /** Fully-qualified bot handle, e.g. mauriciobc@mastodon.social. */
  botHandle: string;
  hostAcct: string;
  player1Acct: string;
  player2Acct: string | null;
  theme: string;
  playlistLength: number;
  pollDurationSec: number;
  tuneUrlsPlayer1: string[];
  tuneUrlsPlayer2: string[];
  waitTimeoutSec: number;
  pollWaitSec: number;
  pollCheckIntervalSec: number;
  finaleTimeoutSec: number;
  debug: boolean;

  // Game state
  gameCreatedStatus: MastodonStatus | null;
  gameUrl: string | null;
  player1DmStatus: MastodonStatus | null;
  player2DmStatus: MastodonStatus | null;
  pollStatuses: MastodonStatus[];
  results: TestResult[];
}

interface TestResult {
  phase: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

// ─── Helpers ─────────────────────────────────────────────────

function log(msg: string) {
  console.log(`\n${msg}`);
}

function check(phase: string, passed: boolean, detail: string, startMs: number, state: TestState) {
  const durationMs = Date.now() - startMs;
  const icon = passed ? "✅" : "❌";
  console.log(`  ${icon} ${phase}: ${detail} (${(durationMs / 1000).toFixed(1)}s)`);
  state.results.push({ phase, passed, detail, durationMs });
}

async function init(cfg: TestConfig): Promise<TestState> {
  const hostApi = new MastodonAPI(`https://${cfg.hostInstance}`, cfg.hostToken, cfg.debug);
  const player1Api = new MastodonAPI(`https://${cfg.player1Instance}`, cfg.player1Token, cfg.debug);
  const player2Api = cfg.player2Token && cfg.player2Instance
    ? new MastodonAPI(`https://${cfg.player2Instance}`, cfg.player2Token, cfg.debug)
    : null;

  // Verify all accounts
  const hostMe = await hostApi.getMe();
  const p1Me = await player1Api.getMe();
  console.log(`  Host: @${hostMe.acct}`);
  console.log(`  Player 1: @${p1Me.acct}`);
  if (player2Api) {
    const p2Me = await player2Api.getMe();
    console.log(`  Player 2: @${p2Me.acct}`);
  }
  console.log(`  Bot: @${cfg.botAcct}`);
  console.log(`  Theme: "${cfg.theme}" (${cfg.playlistLength} tunes)`);

  return {
    hostApi,
    player1Api,
    player2Api,
    botAcct: cfg.botAcct,
    botHandle: `${cfg.botAcct}@${cfg.botInstance}`,
    hostAcct: cfg.hostAcct,
    player1Acct: cfg.player1Acct,
    player2Acct: cfg.player2Acct,
    theme: cfg.theme,
    playlistLength: cfg.playlistLength,
    pollDurationSec: cfg.pollDurationSec,
    tuneUrlsPlayer1: cfg.tuneUrlsPlayer1,
    tuneUrlsPlayer2: cfg.tuneUrlsPlayer2,
    waitTimeoutSec: cfg.waitTimeoutSec,
    pollWaitSec: cfg.pollWaitSec,
    pollCheckIntervalSec: cfg.pollCheckIntervalSec,
    finaleTimeoutSec: cfg.finaleTimeoutSec,
    debug: cfg.debug,
    gameCreatedStatus: null,
    gameUrl: null,
    player1DmStatus: null,
    player2DmStatus: null,
    pollStatuses: [],
    results: [],
  };
}

// ─── Phase 1: Create game ───────────────────────────────────

async function phaseCreate(state: TestState): Promise<void> {
  const start = Date.now();
  log("📋 Phase 1: Create game");

  // Build the challengers list
  const challengers = [`@${state.player1Acct}`];
  if (state.player2Acct) challengers.push(`@${state.player2Acct}`);

  const content = `@${state.botAcct} newgame "${state.theme}" ${state.playlistLength} ${challengers.join(" ")}`;
  console.log(`  Posting: ${content}`);

  // Clear notifications before posting
  await state.hostApi.clearNotifications();

  const status = await state.hostApi.postStatus(content, { visibility: "public" });
  state.gameCreatedStatus = status;
  console.log(`  Posted status: ${status.id}`);

  // Wait for bot reply (confirmation)
  const reply = await waitForBotReply(state.hostApi, state.botAcct, status.id, state.waitTimeoutSec, state.debug);

  const passed = reply !== null;
  const detail = reply
    ? `Bot replied: ${reply.content.replace(/<[^>]+>/g, "").slice(0, 100)}...`
    : "No bot reply received";
  check("create", passed, detail, start, state);
}

// ─── Phase 2: Players accept invites ────────────────────────

async function phaseAccept(state: TestState): Promise<void> {
  const start = Date.now();
  log("📩 Phase 2: Players accept invites");

  // Clear notifications on player accounts
  await state.player1Api.clearNotifications();
  if (state.player2Api) await state.player2Api.clearNotifications();

  // Player 1 sends accept DM
  console.log(`  ${state.player1Acct}: sending accept DM`);
  state.player1DmStatus = await state.player1Api.sendBotDM(state.botHandle, "accept");
  console.log(`  DM sent: ${state.player1DmStatus.id}`);

  // Player 2 sends accept DM (if 2-player game)
  if (state.player2Api && state.player2Acct) {
    console.log(`  ${state.player2Acct}: sending accept DM`);
    state.player2DmStatus = await state.player2Api.sendBotDM(state.botHandle, "accept");
    console.log(`  DM sent: ${state.player2DmStatus.id}`);
  }

  // Wait a moment for bot to process
  await waitFor(5, "bot to process accepts");

  // Verify: check if bot replied with submission instructions
  // (bot should DM each player with "send your tunes" message)
  const p1Reply = await waitForBotReply(state.player1Api, state.botAcct, state.player1DmStatus.id, state.waitTimeoutSec, state.debug);
  const p1Accepted = p1Reply !== null;

  let p2Accepted = true;
  if (state.player2Api && state.player2DmStatus) {
    const p2Reply = await waitForBotReply(state.player2Api, state.botAcct, state.player2DmStatus.id, state.waitTimeoutSec, state.debug);
    p2Accepted = p2Reply !== null;
  }

  const passed = p1Accepted && p2Accepted;
  const detail = `P1: ${p1Accepted ? "accepted" : "NO REPLY"}${state.player2Acct ? `, P2: ${p2Accepted ? "accepted" : "NO REPLY"}` : ""}`;
  check("accept", passed, detail, start, state);
}

// ─── Phase 3: Players submit tunes ──────────────────────────

async function phaseSubmit(state: TestState): Promise<void> {
  const start = Date.now();
  log("🎵 Phase 3: Players submit tunes");

  // Helper: submit tunes one by one via DM
  async function submitTunes(
    api: MastodonAPI,
    acct: string,
    urls: string[],
  ): Promise<{ sent: number; replies: number }> {
    let sent = 0;
    let replies = 0;

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      console.log(`  ${acct}: submitting tune ${i + 1}/${urls.length}: ${url}`);
      const dm = await api.sendBotDM(state.botHandle, url);

      // Wait for acknowledgement (bot should confirm receipt)
      const reply = await waitForBotReply(api, state.botAcct, dm.id, 30, state.debug);
      sent++;
      if (reply) replies++;

      // Small delay to avoid rate limits
      await sleep(1500);
    }

    return { sent, replies };
  }

  // Submit player 1 tunes
  const p1 = await submitTunes(state.player1Api, state.player1Acct, state.tuneUrlsPlayer1);
  console.log(`  P1: sent ${p1.sent}, acknowledged ${p1.replies}`);

  // Submit player 2 tunes
  let p2 = { sent: 0, replies: 0 };
  if (state.player2Api && state.player2Acct) {
    p2 = await submitTunes(state.player2Api, state.player2Acct, state.tuneUrlsPlayer2);
    console.log(`  P2: sent ${p2.sent}, acknowledged ${p2.replies}`);
  }

  const p1Ok = p1.replies > 0;
  const p2Ok = !state.player2Acct || p2.replies > 0;
  const passed = p1Ok && p2Ok;
  const detail = `P1: ${p1.replies}/${p1.sent} ack'd${state.player2Acct ? `, P2: ${p2.replies}/${p2.sent} ack'd` : ""}`;
  check("submit", passed, detail, start, state);
}

// ─── Phase 4: Wait for first poll ───────────────────────────

async function phasePoll(state: TestState): Promise<void> {
  const start = Date.now();
  log("📊 Phase 4: Wait for first poll round");

  // Use the bot's own account to check for new poll statuses — more reliable than notifications
  const timeout = state.pollDurationSec + 60;
  const since = new Date().toISOString();

  console.log(`  Waiting up to ${timeout}s for bot to post a poll...`);
  const poll = await waitForBotPoll(
    state.hostApi, // hostApi is on the same instance as the bot
    since,
    timeout,
    (state.pollCheckIntervalSec || 5) * 1000,
    state.debug,
  );

  if (poll) {
    state.pollStatuses.push(poll);
    console.log(`  Poll status ID: ${poll.id}`);
    if (poll.poll) {
      console.log(`  Options: ${poll.poll.options.map((o) => o.title).join(" vs ")}`);
    }
  }

  const passed = poll !== null;
  const detail = passed
    ? `Found poll ${poll!.id}`
    : `No polls after ${timeout}s — bot may not have posted`;

  check("poll", passed, detail, start, state);
}

// ─── Phase 5: Vote on polls ─────────────────────────────────

async function phaseVote(state: TestState): Promise<void> {
  const start = Date.now();
  log("🗳️  Phase 5: Vote on polls");

  if (state.pollStatuses.length === 0) {
    check("vote", false, "No polls to vote on", start, state);
    return;
  }

  let votesCast = 0;

  for (const pollStatus of state.pollStatuses) {
    if (!pollStatus.poll) continue;

    const poll = pollStatus.poll;
    console.log(`  Voting on poll ${poll.id} (${poll.options.length} options)`);

    // Each player votes for option 0 (arbitrary choice for testing)
    try {
      await state.player1Api.votePoll(pollStatus.id, poll.id, [0]);
      votesCast++;
      console.log(`  P1 voted`);
    } catch (e) {
      console.log(`  P1 vote failed: ${e}`);
    }

    if (state.player2Api) {
      try {
        // Player 2 votes for option 1 (different choice to avoid ties)
        const choiceIdx = poll.options.length > 1 ? 1 : 0;
        await state.player2Api.votePoll(pollStatus.id, poll.id, [choiceIdx]);
        votesCast++;
        console.log(`  P2 voted`);
      } catch (e) {
        console.log(`  P2 vote failed: ${e}`);
      }
    }
  }

  const expected = state.pollStatuses.length * (state.player2Api ? 2 : 1);
  const passed = votesCast > 0;
  const detail = `${votesCast}/${expected} votes cast`;
  check("vote", passed, detail, start, state);
}

// ─── Phase 6: Wait for finale ───────────────────────────────

async function phaseFinale(state: TestState): Promise<void> {
  const start = Date.now();
  log("🏆 Phase 6: Wait for finale / game completion");

  // After all polls resolve, the bot should post a finale announcement
  // This could take several poll durations. Wait a reasonable time.
  const totalWait = state.finaleTimeoutSec || 900;
  const since = new Date().toISOString();

  console.log(`  Waiting up to ${totalWait}s for finale...`);

  const finale = await waitForBotFinale(
    state.hostApi,
    since,
    totalWait,
    (state.pollCheckIntervalSec || 10) * 1000,
    state.debug,
  );

  const passed = finale !== null;
  const detail = finale
    ? `Finale found: ${finale.content.replace(/<[^>]+>/g, "").slice(0, 120)}...`
    : "Finale not detected within timeout — game may still be in progress";
  check("finale", passed, detail, start, state);
}

// ─── Main ───────────────────────────────────────────────────

function printResults(state: TestState) {
  console.log("\n" + "═".repeat(60));
  console.log("  TEST RESULTS");
  console.log("═".repeat(60));

  const passed = state.results.filter((r) => r.passed).length;
  const failed = state.results.filter((r) => !r.passed).length;
  const total = state.results.length;

  for (const r of state.results) {
    const icon = r.passed ? "✅" : "❌";
    console.log(`  ${icon} ${r.phase.padEnd(12)} ${(r.durationMs / 1000).toFixed(1).padStart(6)}s  ${r.detail}`);
  }

  console.log("─".repeat(60));
  console.log(`  Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
  console.log("═".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

async function main() {
  console.log("🎮 Playlist Battle Bot — Integration Test");
  console.log("─".repeat(60));

  const cfg = loadConfig();
  const state = await init(cfg);

  try {
    await phaseCreate(state);
    await phaseAccept(state);
    await phaseSubmit(state);
    await phasePoll(state);
    await phaseVote(state);
    await phaseFinale(state);
  } catch (err) {
    console.error("\n💥 Fatal error:", err);
    state.results.push({
      phase: "fatal",
      passed: false,
      detail: String(err),
      durationMs: 0,
    });
  }

  printResults(state);
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
