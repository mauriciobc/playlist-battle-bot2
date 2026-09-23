import { randomUUID } from "node:crypto";
import { loadConfig, readLogSettings } from "./config.js";
import { createLogger } from "./logger.js";
import { createLoopRunner } from "./singleFlight.js";
import { setLocale } from "./i18n/index.js";
import { migrate, openDatabase, type Db } from "./db/index.js";
import { markStaleOutboxEffectsUnknown, releasePendingNotificationClaims, touchLoopHeartbeat } from "./game/store.js";
import { MastodonClient } from "./mastodon/client.js";
import { initializeNotificationCursor, pollNotifications } from "./mastodon/poller.js";
import {
  checkDeadlines,
  checkPollNotification,
  checkPolls,
  resumeOpenGames,
} from "./scheduler/index.js";
import type { HandlerDeps } from "./handlers/mention.js";
import { resolveTitle, checkAvailable } from "./youtube/oembed.js";
import { createBattlePlaylistPublisher } from "./youtube/playlist.js";
import { APP_VERSION, GIT_SHA, VERSION_STAMP } from "./version.js";

const NOTIFICATION_INTERVAL_MS = 15_000;
const SCHEDULER_INTERVAL_MS = 60_000;
const RECOVERY_INTERVAL_MS = 5 * 60_000;

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

  // Fail fast on bad token / wrong instance
  const me = await client.get<{ id: string; username: string; acct: string }>(
    "/api/v1/accounts/verify_credentials",
  );
  if (me.username.toLowerCase() !== config.botAcct.toLowerCase()) {
    throw new Error(
      `BOT_ACCT does not match the token account: configured ${config.botAcct}, token ${me.username}`,
    );
  }
  const unknownEffects = markStaleOutboxEffectsUnknown(db, 0);
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

  const instanceDomain = new URL(config.mastodonUrl).hostname;
  const deps: HandlerDeps = {
    db,
    client,
    botAcct: config.botAcct,
    instanceDomain,
    pollDurationSec: config.pollDurationSec,
    acceptanceWindowSec: config.acceptanceWindowSec,
    submissionWindowSec: config.submissionWindowSec,
    creationCooldownSec: config.creationCooldownSec,
    maxGamesPerPlayer: config.maxGamesPerPlayer,
    lookup: async (acct: string) => {
      const r = await client.get<{ id: string; acct: string; username: string }>(
        `/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`,
      );
      return { id: r.id, acct: r.acct, username: r.username };
    },
    resolveTitle: (videoId: string) => resolveTitle(videoId, { db }),
    checkAvailable: (videoId: string) => checkAvailable(videoId),
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
  };
  // Fast path for poll-expiry notifications (breaks handler → scheduler import cycle)
  deps.onPollExpired = async (statusId) => {
    await checkPollNotification({ handler: deps, now: deps.now }, statusId);
  };
  // Unexpected player-facing failures keep their internals in the log only.
  deps.log = (message, detail) => log.warn({ detail }, message);
  deps.logger = log;

  const earlyClose = {
    enabled: config.earlyCloseEnabled,
    minAgeSec: config.earlyCloseMinAgeSec,
    stagnationSec: config.earlyCloseStagnationSec,
  };

  // Recover open games from previous run (PRD §7 restart)
  await resumeOpenGames({ handler: deps, now: deps.now, earlyClose });
  touchLoopHeartbeat(db, "recovery", deps.now());
  log.info("resumeOpenGames complete");

  // Single-flight per loop: a tick that overruns (retry sleeps, Retry-After)
  // must not overlap the next one and double-resolve a poll/notification.
  const run = createLoopRunner({
    onSkip: (loop) => log.warn({ loop }, "previous tick still running; skipping this one"),
    onError: (loop, err) => log.error({ err, loop }, "interval task failed; will retry next tick"),
  });

  const runLoop = (label: string, task: () => Promise<unknown>): void => {
    run(label, async () => {
      await task();
      touchLoopHeartbeat(db, label, deps.now());
    });
  };

  const notificationTimer = setInterval(
    () => runLoop("notifications", () => pollNotifications(deps)),
    NOTIFICATION_INTERVAL_MS,
  );
  const deadlineTimer = setInterval(
    () => runLoop("deadlines", () => checkDeadlines({ handler: deps, now: deps.now, earlyClose })),
    SCHEDULER_INTERVAL_MS,
  );
  const pollTimer = setInterval(
    () => runLoop("polls", () => checkPolls({ handler: deps, now: deps.now, earlyClose })),
    SCHEDULER_INTERVAL_MS,
  );
  const recoveryTimer = setInterval(
    () => runLoop("recovery", () => resumeOpenGames({ handler: deps, now: deps.now, earlyClose })),
    RECOVERY_INTERVAL_MS,
  );

  log.info(
    {
      version: APP_VERSION,
      gitSha: GIT_SHA,
      bot: me.username,
      instance: instanceDomain,
      pollDurationSec: config.pollDurationSec,
      earlyClose: config.earlyCloseEnabled,
      logLevel: logSettings.level,
      logPretty: logSettings.pretty,
    },
    "playlist-battle bot running",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutting down");
    clearInterval(notificationTimer);
    clearInterval(deadlineTimer);
    clearInterval(pollTimer);
    clearInterval(recoveryTimer);
    await run.drain();
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
