import { randomUUID } from "node:crypto";
import { loadConfig, readLogSettings, type BotConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { createLoopRunner } from "./singleFlight.js";
import { setLocale } from "./i18n/index.js";
import { migrate, openDatabase, type Db } from "./db/index.js";
import { LOOP_LABELS, touchLoopHeartbeat, type LoopLabel } from "./db/heartbeats.js";
import { releasePendingNotificationClaims } from "./db/notifications.js";
import { markPendingOutboxEffectsUnknown } from "./db/outbox.js";
import { MastodonClient, RateLimitError } from "./mastodon/client.js";
import { initializeNotificationCursor, pollNotifications } from "./mastodon/poller.js";
import {
  checkDeadlines,
  checkPollNotification,
  checkPolls,
  resumeOpenGames,
  type SchedulerDeps,
} from "./scheduler/index.js";
import type { HandlerDeps } from "./handlers/deps.js";
import { resolveTitle, checkAvailable } from "./youtube/oembed.js";
import { createBattlePlaylistPublisher } from "./youtube/playlist.js";
import { APP_VERSION, GIT_SHA, VERSION_STAMP } from "./version.js";
import { fromUnixSeconds, MS_PER_SECOND } from "./time.js";

async function main(): Promise<void> {
  // Log settings and the build identity come first: a malformed or missing
  // stack.env is the most common fresh-deploy failure, and it must not hide
  // which build is deployed (Portainer, docker logs, CI).
  const logSettings = readLogSettings();
  const log = createLogger(logSettings.level, { pretty: logSettings.pretty });
  log.info(
    { version: APP_VERSION, gitSha: GIT_SHA, node: process.version },
    `playlist-battle bot ${VERSION_STAMP} starting`,
  );
  const config = loadConfig();
  setLocale(config.locale);
  const db: Db = openDatabase(config.dbPath);
  migrate(db);
  // Notifications claimed by a previous run that died mid-handle → retry them
  releasePendingNotificationClaims(db);

  const client = new MastodonClient({
    baseUrl: config.mastodonUrl,
    token: config.mastodonToken,
    db,
    log,
  });
  const me = await verifyBotAccount(client, config.botAcct);
  const unknownEffects = markPendingOutboxEffectsUnknown(db);
  if (unknownEffects > 0) {
    log.warn({ unknownEffects }, "outbox effects marked unknown after restart; inspect before retrying");
  }

  await initializeNotificationCursor({ db, client });

  if (config.autoDeleteUnsafe) {
    log.warn(
      {
        autoDeleteWindowHours: config.autoDeleteWindowHours,
        pollDurationSec: config.pollDurationSec,
      },
      "AUTO_DELETE_WINDOW_HOURS is shorter than the worst-case game duration — posts (and games) may vanish mid-duel. Increase the window or set 0 if auto-delete is off.",
    );
  }

  const deps = createHandlerDeps(config, db, client, log);
  const scheduler: SchedulerDeps = {
    handler: deps,
    earlyClose: {
      enabled: config.earlyCloseEnabled,
      minAgeSec: config.earlyCloseMinAgeSec,
      stagnationSec: config.earlyCloseStagnationSec,
    },
  };
  // Fast path for poll-expiry notifications (breaks handler → scheduler import cycle)
  deps.onPollExpired = async (statusId) => {
    await checkPollNotification(scheduler, statusId);
  };

  // Recover open games from previous run (PRD §7 restart)
  await resumeOpenGames(scheduler);
  touchLoopHeartbeat(db, "recovery", deps.now());
  log.info("resumeOpenGames complete");

  const loops = startLoops(config, scheduler, log);

  log.info(
    {
      version: APP_VERSION,
      gitSha: GIT_SHA,
      bot: me.username,
      instance: deps.instanceDomain,
      pollDurationSec: config.pollDurationSec,
      earlyClose: config.earlyCloseEnabled,
      runMode: config.runMode,
      earlyCloseMinAgeSec: config.earlyCloseMinAgeSec,
      earlyCloseStagnationSec: config.earlyCloseStagnationSec,
      schedulerIntervalSec: config.schedulerIntervalSec,
      logLevel: logSettings.level,
      logPretty: logSettings.pretty,
    },
    "playlist-battle bot running",
  );

  shutDownOnSignal(loops, db, log);
}

/** Fail fast on a bad token or a token for another account. */
async function verifyBotAccount(client: MastodonClient, botAcct: string): Promise<{ username: string }> {
  const me = await client.get<{ id: string; username: string; acct: string }>(
    "/api/v1/accounts/verify_credentials",
  );
  if (me.username.toLowerCase() !== botAcct.toLowerCase()) {
    throw new Error(
      `BOT_ACCT does not match the token account: configured ${botAcct}, token ${me.username}`,
    );
  }
  return me;
}

function createHandlerDeps(config: BotConfig, db: Db, client: MastodonClient, log: Logger): HandlerDeps {
  return {
    db,
    client,
    botAcct: config.botAcct,
    instanceDomain: new URL(config.mastodonUrl).hostname,
    pollDurationSec: config.pollDurationSec,
    acceptanceWindowSec: config.acceptanceWindowSec,
    submissionWindowSec: config.submissionWindowSec,
    creationCooldownSec: config.creationCooldownSec,
    maxGamesPerPlayer: config.maxGamesPerPlayer,
    lookup: (acct: string) =>
      client.get<{ id: string; acct: string }>(`/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`),
    resolveTitle: (videoId: string) => resolveTitle(videoId, { db }),
    checkAvailable,
    // Fails fast at boot when a configured cookie is unusable.
    publishBattlePlaylist: createBattlePlaylistPublisher({
      auth: config.ytCookie
        ? { cookie: config.ytCookie, authUser: config.ytAuthUser }
        : null,
      privacy: config.ytPlaylistPrivacy,
      log: (message, detail) => log.warn({ detail }, message),
    }),
    replacementGraceMin: config.replacementGraceMin,
    now: () => new Date(),
    newGameId: () => randomUUID(),
    logger: log,
  };
}

type RunningLoops = { stop: () => Promise<void> };

/**
 * Start every interval loop. Each is single-flight: a tick that overruns
 * (retry sleeps, Retry-After) must not overlap the next one and
 * double-resolve a poll/notification.
 */
function startLoops(config: BotConfig, scheduler: SchedulerDeps, log: Logger): RunningLoops {
  const deps = scheduler.handler;
  /** Per-loop pause imposed by a rate limit, cleared once resetAt passes. */
  const backoffUntil = new Map<string, Date>();

  const run = createLoopRunner({
    onSkip: (loop) => log.warn({ loop }, "previous tick still running; skipping this one"),
    onError: (loop, err) => {
      log.error({ err, loop }, "interval task failed; will retry next tick");
      // A rate-limited tick must not be retried on the normal cadence. Each
      // retry is another rejected request, and a rejected request refreshes
      // the very window being waited out: at 5s per tick under RUN_MODE=e2e
      // the loop never stopped, holding the cursor frozen for the whole
      // window (47 cycles in 4 minutes). Back off until Mastodon says the
      // window resets. Every other error still retries next tick.
      if (err instanceof RateLimitError) {
        const until = fromUnixSeconds(err.resetAt);
        backoffUntil.set(loop, until);
        log.warn(
          { loop, until: until.toISOString() },
          "rate limited; suspending loop until the window resets",
        );
      }
    },
  });

  const loops: Record<LoopLabel, [intervalSec: number, task: () => Promise<unknown>]> = {
    notifications: [config.notificationIntervalSec, () => pollNotifications(deps)],
    deadlines: [config.schedulerIntervalSec, () => checkDeadlines(scheduler)],
    polls: [config.schedulerIntervalSec, () => checkPolls(scheduler)],
    recovery: [config.recoveryIntervalSec, () => resumeOpenGames(scheduler)],
  };
  const timers = LOOP_LABELS.map((label) => {
    const [intervalSec, task] = loops[label];
    return setInterval(() => {
      run(label, async () => {
        // Skip quietly while a rate limit is in force. Ticking anyway is what
        // turned a five-minute window into a permanent one.
        const until = backoffUntil.get(label);
        if (until && until.getTime() > deps.now().getTime()) return;
        backoffUntil.delete(label);
        await task();
        touchLoopHeartbeat(deps.db, label, deps.now());
      });
    }, intervalSec * MS_PER_SECOND);
  });

  return {
    stop: async () => {
      for (const timer of timers) clearInterval(timer);
      await run.drain();
    },
  };
}

/** On SIGINT/SIGTERM: stop the loops, let in-flight ticks finish, close the database. */
function shutDownOnSignal(loops: RunningLoops, db: Db, log: Logger): void {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    await loops.stop();
    try {
      db.close();
    } catch (err) {
      log.error({ err }, "error closing database");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
