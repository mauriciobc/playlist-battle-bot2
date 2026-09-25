# Playlist Battle Bot

A TypeScript/Node.js Mastodon bot for running public playlist duels. Players create a duel from a public mention, accept or decline by DM, submit YouTube playlists, and vote in scheduled public polls.

## Requirements

- Node.js 22 or newer
- npm
- A Mastodon account with the scopes listed in `.env.example`
- A persistent writable directory for SQLite
- Optional YouTube Music credentials for saved finale playlists

## Configuration

Copy `.env.example` to `.env` and set the required values locally. Do not commit `.env`, `.env_`, cookies, tokens, or database files.

Required values:

- `MASTODON_URL`
- `MASTODON_TOKEN`
- `BOT_ACCT`

The timing, poll, rate-limit, privacy, YouTube, and database settings are documented in `.env.example`.

The process reads environment variables directly. Export them through the shell, a secret manager, or the container runtime.

## Local development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run e2e:console
npm run e2e:console -- --random --seed=42
npm run build
npm start
```

`npm start` runs the compiled `dist/index.js`, so run `npm run build` first. `npm run dev` starts the TypeScript watcher and also requires environment variables to be present in the process environment.

## Live debugging

Logs are structured JSON (pino). For live/staging troubleshooting:

- `LOG_LEVEL=debug` traces notification fetch/classify/handle outcomes, every Mastodon HTTP request (method, path, status, duration, retries), and scheduler sweeps (deadlines, polls, recovery).
- `LOG_PRETTY=1` colorizes output for local runs via `pino-pretty` (devDependency). Production images fall back to JSON if it is not installed.
- Sensitive fields (`token`, cookies, `Authorization`) are redacted automatically.

Example local run:

```bash
LOG_LEVEL=debug LOG_PRETTY=1 npm run dev
```

## Commands

- Public: `@bot newgame "<theme>" 8-12 @challenger [@challenger...]`
- Public: `@bot status`
- DM: `accept` or `decline`
- DM: one YouTube link per line during submission collection
- DM: `replace <position> <YouTube URL>`
- DM: `cancel` for the host

The configured locale can be `en` or `pt-BR`. See `RULES.md` for the full game rules and lifecycle.

## Docker deployment

```bash
docker compose config --quiet
docker compose build
docker compose up -d
```

The service is pinned to `pull_policy: build`, so `docker compose up -d` (including a Portainer stack update) rebuilds the image from the checked-out source instead of reusing the image already on the host. Verify the running build in the logs: the first line must read `playlist-battle bot <version> (<GIT_SHA>) starting`. Set `GIT_SHA` in `.env`/`stack.env` to the deployed commit or it logs `dev`. If that line is missing, the container is running an older image.

The Compose deployment stores SQLite at `/app/data/bot.db` in the `bot-data` volume. Back up the volume before upgrades or destructive operations.

The image runs an internal health check that requires fresh heartbeats for the notification, deadline, poll, and recovery loops. There is no public HTTP health endpoint. Monitor the process, structured logs, database file, and scheduler activity externally. A failed loop should be investigated before allowing the container to continue unattended.

## Persistence and recovery

SQLite uses WAL mode and foreign keys. Migrations run automatically at startup. The notification cursor, processed notifications, dead-letter records, games, rounds, and video metadata are stored in the database.

For recovery:

1. Stop the bot.
2. Copy the entire database volume, including SQLite WAL files if present.
3. Start the bot and inspect logs for migration or resume messages.
4. Restore the volume if startup repeatedly fails.

The scheduler retries open polls, terminal poll cleanup, replacement notifications, and incomplete game transitions. Round/finale/result posts use stable idempotency keys, and resolved queue URLs are persisted before publication. Mastodon writes are recorded in `outbox_effects`; effects left uncertain by a restart are quarantined for operator review. Dead-lettered notifications are retained in `notification_failures` for operator inspection.

## Release verification

Before a release:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run e2e:console
npm run e2e:console -- --random --seed=42
npm run build
npm audit --audit-level=moderate
```

Run a live staging-instance game before production deployment. Include acceptance, submissions, a dead-video replacement, a rate-limited request, restart, cancellation, and account deletion in the staging checklist.
