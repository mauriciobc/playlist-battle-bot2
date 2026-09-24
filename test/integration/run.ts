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
import { MastodonAPI, waitForBotReply, waitForBotDM, waitForBotPost, waitForBotPoll, waitForBotFinale, waitFor, sleep, type MastodonStatus } from "./mastodon-helpers.js";

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
  tuneUrlsHost: string[];
  tuneUrlsPlayer1: string[];
  tuneUrlsPlayer2: string[];
  waitTimeoutSec: number;
  pollWaitSec: number;
  pollCheckIntervalSec: number;
  finaleTimeoutSec: number;
  debug: boolean;

  // Game state
  gameCreatedStatus: MastodonStatus | null;
  /** Timestamp of the last tune submission - phase 4's anchor. */
  lastSubmitAt: string | null;
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
  console.log(`  Bot: @${cfg.botAcct} on ${cfg.botInstance}`);
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
    tuneUrlsHost: cfg.tuneUrlsHost,
    tuneUrlsPlayer1: cfg.tuneUrlsPlayer1,
    tuneUrlsPlayer2: cfg.tuneUrlsPlayer2,
    waitTimeoutSec: cfg.waitTimeoutSec,
    pollWaitSec: cfg.pollWaitSec,
    pollCheckIntervalSec: cfg.pollCheckIntervalSec,
    finaleTimeoutSec: cfg.finaleTimeoutSec,
    debug: cfg.debug,
    gameCreatedStatus: null,
    lastSubmitAt: null,
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

  // Bot DMs are standalone posts, not threaded replies, so record a timestamp
  // to find the bot's response via waitForBotPost instead of waitForBotReply.
  const acceptSentAt = new Date().toISOString();

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
  const p1Reply = await waitForBotDM(
    state.player1Api,
    state.botHandle,
    acceptSentAt,
    state.waitTimeoutSec,
    state.debug,
  );
  const p1Accepted = p1Reply !== null;

  let p2Accepted = true;
  if (state.player2Api && state.player2DmStatus) {
    const p2Reply = await waitForBotDM(
      state.player2Api,
      state.botHandle,
      acceptSentAt,
      state.waitTimeoutSec,
      state.debug,
    );
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

  /**
   * Submit one player's tunes.
   *
   * Deliberately does NOT wait for a per-tune acknowledgement. A same-instance
   * DM is absent from /conversations, so an ack wait there burns 60s per tune
   * and the host alone spent ~8 minutes waiting for messages it structurally
   * cannot observe. The real completion signal is the poll, which the bot only
   * posts once BOTH players have submitted - that is phase 4's job.
   *
   * acksSeen is informational: it reports how many confirmations were
   * observable, and is never the pass/fail criterion.
   */
  async function submitTunes(
    api: MastodonAPI,
    acct: string,
    urls: string[],
    waitForAcks: boolean,
  ): Promise<{ sent: number; acks: number }> {
    let sent = 0;
    let acks = 0;

    for (const url of urls) {
      sent++;
      await api.sendBotDM(state.botHandle, url);

      if (waitForAcks) {
        const sentAt = new Date(Date.now() - 1000).toISOString();
        const reply = await waitForBotDM(api, state.botHandle, sentAt, 15, state.debug);
        if (reply) acks++;
      } else {
        // Space submissions so the bot's notification loop can keep up.
        await sleep(1500);
      }
    }

    return { sent, acks };
  }

  // The challenger is cross-instance: its acks ARE observable via
  // /conversations, so confirming them is cheap and worth doing. The host is
  // same-instance, where they are not - waiting there only wastes the clock.
  const host = await submitTunes(state.hostApi, state.hostAcct, state.tuneUrlsHost, false);
  console.log(`  HOST: sent ${host.sent} (acks not observable same-instance, not awaited)`);

  const p1 = await submitTunes(state.player1Api, state.player1Acct, state.tuneUrlsPlayer1, true);
  console.log(`  P1: sent ${p1.sent}, acknowledged ${p1.acks}`);

  let p2 = { sent: 0, acks: 0 };
  if (state.player2Api && state.player2Acct) {
    p2 = await submitTunes(state.player2Api, state.player2Acct, state.tuneUrlsPlayer2, true);
    console.log(`  P2: sent ${p2.sent}, acknowledged ${p2.acks}`);
  }

  state.lastSubmitAt = new Date().toISOString();
  const totalSent = host.sent + p1.sent + p2.sent;
  const expected = state.playlistLength * (state.player2Acct ? 3 : 2);
  const passed = totalSent === expected;
  const detail = `${totalSent}/${expected} submitted` +
    (p1.acks ? `, P1 acks ${p1.acks}/${p1.sent}` : "");
  check("submit", passed, detail, start, state);
}

// ─── Phase 4: Wait for first poll ───────────────────────────

async function phasePoll(state: TestState): Promise<void> {
  const start = Date.now();
  log("📊 Phase 4: Wait for first poll round");

  // The bot posts a poll only once BOTH players have submitted, so the poll
  // IS the completion signal - not a timer. The timeout below is a backstop
  // that stops the run hanging forever; it is not what we wait on.
  // The poll arrives in reply to the DM thread, so anchor on the last
  // submission rather than "now".
  const timeout = state.pollDurationSec + 120;
  const since = state.lastSubmitAt ?? new Date().toISOString();

  console.log(`  Waiting for bot to post a poll (backstop ${timeout}s)...`);
  const poll = await waitForBotPoll(
    state.player1Api, // can see the bot's public statuses across instances
    state.botHandle,
    since,
    timeout,
    (state.pollCheckIntervalSec || 5) * 1000,
    state.debug,
  );

  if (poll) {
    console.log(`  Poll status ID: ${poll.id}`);
    if (poll.poll) {
      console.log(`  Options: ${poll.poll.options.map((o) => o.title).join(" vs ")}`);
    }
  }

  if (poll) state.pollStatuses.push(poll);

  const passed = poll !== null;
  const detail = passed
    ? `Found poll ${poll!.id} (${poll!.poll?.options.length ?? 0} options)`
    : `No poll from bot within ${timeout}s backstop`;

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
  // Anchor on the poll: the finale comes after the rounds resolve.
  const since = state.pollStatuses[0]?.created_at ?? new Date().toISOString();

  console.log(`  Waiting for finale announcement (backstop ${totalWait}s)...`);

  const finale = await waitForBotFinale(
    state.player1Api,
    state.botHandle,
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
