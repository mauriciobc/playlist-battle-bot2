# Playlist Battle Bot

A TypeScript/Node.js Mastodon bot for running public playlist duels. Players create a duel from a public mention, accept or decline by DM, submit YouTube playlists, and vote in scheduled public polls.

## Requirements

- Node.js 22 or newer
- npm
- A Mastodon account with the scopes listed in `.env.example`
- A persistent writable directory for SQLite
- Optional YouTube Music credentials for saved finale playlists

## Configuration

Copy `.env.example` to `.env` and set the required values. Do not commit `.env`, `.env_`, cookies, tokens, or database files.

Required values:

- `MASTODON_URL`
- `MASTODON_TOKEN`
- `BOT_ACCT`

The timing, poll, rate-limit, privacy, YouTube, and database settings are documented in `.env.example`.

The process reads environment variables directly and never loads a `.env` file on its own. `.env` is loaded only by Docker Compose (its `env_file`), so for every other run you must supply the values yourself:

```bash
npm start -- --env-file=.env   # or: npm run dev -- --env-file=.env
```

Alternatively, export them through the shell, a secret manager, or the container runtime.

## Local development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run e2e:console
npm run e2e:console -- --random --seed=42
npm run bench:sim
npm run build
npm start
```

`npm start` runs the compiled `dist/index.js`, so run `npm run build` first; `npm run dev` starts the TypeScript watcher instead. Both need the environment variables in the process environment — see §Configuration for loading `.env`. They are the only commands in this block that talk to Mastodon or YouTube; everything else is offline apart from `npm ci`.

`npm run bench:sim` replays the same eight scenarios as `npm run e2e:console` in-process (one scripted-vote pass plus six fixed RNG seeds), discards three warmup repeats, then times twenty-five repeats and reports how long the fixed workload takes. It talks to nothing: the database is in-memory, the Mastodon client is the console adapter and YouTube's queue endpoint is stubbed, so the number is comparable across machines and runs. It also pins the delivered volume, so a run that stops sending statuses or DMs fails instead of getting quietly faster.

## Live debugging

Logs are structured JSON (pino). For live/staging troubleshooting:

- `LOG_LEVEL=debug` traces notification fetch/classify/handle outcomes, every Mastodon HTTP request (method, path, status, duration, retries), and scheduler sweeps (deadlines, polls, recovery).
- `LOG_PRETTY=1` colorizes output for local runs via `pino-pretty` (devDependency). Production images fall back to JSON if it is not installed.
- Credential-shaped fields are redacted automatically: the Mastodon `token`, `ytCookie`, and any `cookie` or `authorization` value, including nested under `headers`.

Example local run:

```bash
LOG_LEVEL=debug LOG_PRETTY=1 npm run dev
```

## Commands

Every command word below also has a pt-BR alias (`LOCALE=pt-BR` changes the replies, not the vocabulary — both spellings work in either locale).

| Where | Command |
| --- | --- |
| Public | `@bot newgame "<theme>" 8-12 @challenger [@challenger...]` (`novojogo`, `novo jogo`) |
| Public | `@bot status` (`ajuda`) |
| Public | `@bot ranking` (`classificacao`) — the 30-day leaderboard, plus your position |
| Public | `@bot badges` (`conquistas`, `achievements`) — your own record |
| DM | `ranking` (`classificacao`) or `badges` (`conquistas`) — the same two views, privately |
| DM | `accept` (`aceitar`) or `decline` (`recusar`) |
| DM | `cancel` (`cancelar`) — host only |
| DM | one or more YouTube links per message (separated by lines, spaces or commas) during submission collection; links that are rejected are listed in one note |
| DM | `replace <position> <YouTube URL>` (`trocar`, `substituir`) |

Accents on `classificacao` are optional, so a keyboard that drops the cedilla still works.

The configured locale can be `en` or `pt-BR`; it selects the reply language, and does not change which commands are accepted. See `RULES.md` for the full game rules and lifecycle.

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

The scheduler retries open polls, terminal poll cleanup, replacement notifications, and incomplete game transitions. Round/finale/result posts use stable idempotency keys, and resolved queue URLs are persisted before publication. Mastodon writes are recorded in `outbox_effects`; an effect still `pending` when the process died is flipped to `unknown` on the next boot and logged as a warning, because it may or may not have reached the server. `unknown` does not block a retry — the idempotency key is what prevents a duplicate, so those rows are for operator review, not a hold. Dead-lettered notifications are retained in `notification_failures` for operator inspection.

## Release verification

Before a release:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run e2e:console
npm run e2e:console -- --random --seed=42
npm run bench:sim
npm run build
npm audit --audit-level=moderate
```

`npm run bench:sim` is in this list on purpose: it pins the number of statuses and DMs the scenarios deliver, so a change that stops sending something fails loudly instead of quietly getting faster. CI runs the same block. **When you add or remove a status or DM in the bot, re-pin `EXPECTED_CHECKS` / `EXPECTED_DELIVERED` in `scripts/bench-sim.ts`** — the new values are printed by the failing run.

Run a live staging-instance game before production deployment. Include acceptance, submissions, a dead-video replacement, a rate-limited request, restart, cancellation, and account deletion in the staging checklist.
