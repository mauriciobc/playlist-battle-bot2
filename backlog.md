# Playlist Battle — Implementation Backlog

**PRD:** `C:\Users\mauri\Downloads\playlist_battle_prd.md` · **Plan:** see session plan
**Status legend:** `TODO` · `WIP` · `DONE` · `BLOCKED`

## v1.1 Rule Patch (brief: playlist_battle_v1.1_agent_brief.md)

### Code (items 1.1–1.7)
- [x] DONE 1.1 full-commitment finalize + restart-safe deadline reconciliation (`engine.ts`, `scheduler/index.ts`)
- [x] DONE 1.2 ROUND_QUORUM = 3 (`scoring.ts`, `resolveRoundScore`)
- [x] DONE 1.3 final-round tie splits pot (`resolveRound` FinalSplit, `splitPotAmong`, i18n finalePotSplit)
- [x] DONE 1.4 availability window + announced-round sweep + auto-tie walkover skip (`roundState.ts`, `scheduler/index.ts`, `oembed.ts` checkAvailable)
- [x] DONE 1.5 DM-throw → forfeit (`deletion.ts`, `dm.ts`, stateMachine PLAYER_DELETED)
- [x] DONE 1.6 replace DM (`replace <n> <url>`) + round-replacement link window (`commands.ts`, `mention.ts`)
- [x] DONE 1.7 deterministic poll shuffle (`game/shuffle.ts`)
- [x] DONE config `REPLACEMENT_GRACE_MIN` + worst-case formula (`config.ts`, `.env.example`)
- [x] DONE i18n keys (both locales) + roundAnnounce judging line

### Tests & verification
- [x] DONE typecheck/lint clean
- [x] DONE scoring.spec quorum + config.spec auto-delete §2.4 formula
- [x] DONE v1.1 unit tests: shuffle + checkAvailable + replace/edit + availability window + deletion precedence (`tests/v1-1.spec.ts`, 21 tests; 302 total green)
- [x] DONE e2e-console ledger rewrite (quorum mirror, final split of pre-round pot, quorum-safe vectors, scenario C dead-video walkover) — scripted 98 checks PASS + `--random --seed=42` PASS
- [x] DONE full verification: test, typecheck, lint, e2e:console, random seed=42

### Docs (§2)
- [x] DONE README.md — replace DM syntax, players-may-vote, quorum, split (replaces void), worst-case window, round showdown, replacement grace, walkover/FORFEIT precedence, cancel voids
- [x] DONE RULES.md — Quorum row, Unavailable-videos, `replace` DM, edit-until-deadline, precedence, restart-safe partial handling, pot split, worst-case formula, judging prompt, shuffled order, cancel semantics, round showdown

### PRD (item 1.3)
- [DONE] no-op — PRD not in repo

## Locked decisions
- [x] Stack: TypeScript / Node 22+, ESM
- [x] Deploy: Docker + VPS (single container, SQLite volume)
- [x] DB: SQLite via better-sqlite3 (WAL)
- [x] Rate limits: 10-min creation cooldown, 3 concurrent games/player
- [x] Poll duration: global, manager-set only
- [x] Commands: reply-based (`newgame`/`status`; DM `accept`/`decline`)
- [x] Defaults: void pot on final tie · shared championship · within-playlist dupes rejected

## Phase 1 — Scaffold + infrastructure
- [x] DONE `package.json`, tsconfig (ESM), eslint, vitest setup
- [x] DONE `config.ts` — zod env schema (`.env.example`)
- [x] DONE `logger.ts` — pino
- [x] DONE `db/index.ts` — better-sqlite3, WAL, migrations runner
- [x] DONE `mastodon/client.ts` — fetch wrapper, retry/backoff, X-RateLimit handling
- [x] DONE Dockerfile + docker-compose.yml skeleton
- **Done when:** verify_credentials works under rate limiting; migrations idempotent ✅ (27 tests green)

## Phase 2 — YouTube layer
- [x] DONE `youtube/normalize.ts` — watch/youtu.be/shorts/embed/music → canonical video ID
- [x] DONE `youtube/oembed.ts` — title resolution + `video_cache` table
- [x] DONE Unit tests: all URL shapes, invalid links, dup IDs, cache hits
- **Done when:** tests green for §5.3 validation rules ✅ (45 tests total)

## Phase 3 — Domain engine (pure, TDD)
- [x] DONE `game/types.ts` — Game/Player/Tune/Round + status enums
- [x] DONE `game/stateMachine.ts` — transition table + guards
- [x] DONE `game/scoring.ts` — points, pot accrual/award/void, standings, ties
- [x] DONE `game/engine.ts` — create/accept/submit/resolve/forfeit/finalize
- [x] DONE `game/rateLimit.ts` — cooldown + concurrent cap
- [x] DONE Edge-case coverage: every row of PRD §7 table
- [x] DONE Poll option abbreviation (25-char) + 500-char post guard in `templates/truncate.ts`
- **Done when:** full unit coverage of §6 scoring + §7 edge cases ✅ (131 tests green)

## Phase 4 — Inbound: notifications, commands, DMs
- [x] DONE `mastodon/notifications.ts` — since_id poller + `processed_notifications` dedupe
- [x] DONE `handlers/commands.ts` — parse `newgame`/`status`/`help`, validation replies
- [x] DONE `handlers/mention.ts` — public command routing + full create/accept/submit flow
- [x] DONE `handlers/mention.ts` DM path — accept/decline, link collection (1-per-line fast path)
- [x] DONE Local-account check via accounts lookup (reject remote accts) — later dropped: federated players/votes allowed
- [x] DONE Integration tests with mocked notifications (happy path + validation failures)
- **Done when:** create → accept → submit driven end-to-end in tests ✅ (167 tests green)

## Phase 5 — Outbound: threads, polls, finale
- [x] DONE `mastodon/posts.ts` — thread chain, visibility, length assert
- [x] DONE DM path via `handlers/mention.ts` (dm helper, conversation-level direct posts)
- [x] DONE Round flow: announce → tune posts ×players → poll post (+ auto-tie/walkover short-circuits)
- [x] DONE Auto-tie short-circuit (duplicate video IDs, no poll)
- [x] DONE Round resolution post (standings/pot/winner)
- [x] DONE Finale: new thread — summary + one post per winning tune + champion mention
- [x] DONE Side-effect posts: EXPIRED / FIZZLED / FORFEIT on creation post
- [x] DONE Message copy lives in `posts.ts` (asserted ≤500 chars) + `truncate.ts`
- **Done when:** integration tests assert post order, option maps, length limits ✅ (182 tests green)

## Phase 6 — Scheduler + poll lifecycle
- [x] DONE `scheduler/index.ts` — `checkDeadlines` (acceptance + submission windows) + `checkPolls` (expires_at sweep + `type=poll` fast path)
- [x] DONE `scheduler/roundState.ts` — mark round resolved, advance to finale, emit finale thread
- [x] DONE Tally → award points/pot → advance round or finale (`resolvePollRow`)
- [x] DONE Side-effect posts on EXPIRED / FIZZLED / default_win (creation thread)
- [x] DONE Auto-delete safety: `config.autoDeleteUnsafe` flag (surfaced at boot in Phase 8)
- [x] DONE Simulated-clock tests: multi-round game → finale with correct scores
- **Done when:** clock-driven full game resolves correctly ✅ (195 tests green)

## Phase 7 — Edge cases + resilience
- [x] DONE Incomplete playlist (m < N): forfeit rounds m+1…N, exclude from later polls
- [x] DONE Zero-complete → FIZZLED; one-complete → default win; walkover rounds
- [x] DONE Player deleted/unreachable → FORFEIT closure (`handlePlayerDeleted`)
- [x] DONE Concurrent games per player + cross-game isolation
- [x] DONE Restart-resume: `resumeOpenGames` reloads open games, recovers READY/FINALE stuck states
- [x] DONE Mastodon 429/5xx retry + crash-safe cursor advance (`poller.ts` advances only after handler success)
- [x] DONE Chaos tests: kill at INVITED/COLLECTING/READY/ROUND/FINALE → resume completes
- **Done when:** resume drill passes at every state ✅ (211 tests green)

## Phase 8 — Docker + deploy + E2E
- [x] DONE Multi-stage Dockerfile (build → slim runtime, non-root, data volume)
- [x] DONE `docker-compose.yml` — env_file + SQLite volume, restart unless-stopped
- [x] DONE `src/index.ts` real entrypoint — verify_credentials, autoDeleteUnsafe boot warn, resumeOpenGames, notification/deadline/poll loops, graceful shutdown
- [x] DONE README: instance setup, OAuth scopes, auto-delete guidance, runbook, E2E procedure
- [x] DONE Simulated E2E (`tests/e2e.spec.ts`): 2 players, 8-length, full create→accept→submit→8 polls→finale→CLOSED via notification pipeline ✅ (212 tests green)
- [ ] BLOCKED E2E on live test instance: 2 players, 8-length, 5-min polls, full game → finale thread — needs user's test Mastodon instance + token (manual runbook in README)
- **Done when:** real game completes on a test Mastodon instance (simulated E2E green; live run pending credentials)

## Risks / watch items
- [ ] Notification cursor: advance only after handler success + dedupe table
- [ ] DM threading: chain `in_reply_to_id`; store `last_dm_status_id` per player/game
- [ ] Poll option abbreviation: deterministic tests (long titles, unicode, emoji)
- [ ] Auto-delete window: startup health check must warn loudly
- [ ] Instance quirks (poll duration caps, bot DM filtering): config validation, not crashes

## Open questions
- [ ] None — all PRD §10 open items resolved (see locked decisions)

## Remediation follow-up

- [x] Persist game/player creation before outbound effects and resume interrupted invitations
- [x] Enforce theme limits and submission/replacement deadlines
- [x] Preserve future-deadline partial playlists across restarts
- [x] Add notification pagination, first-boot cursor initialization, and dead-letter persistence
- [x] Add request timeouts and stricter poll-response validation
- [x] Add transactional round updates, conditional terminal transitions, and periodic recovery
- [ ] Complete live Mastodon staging E2E and Docker/backup validation
- [x] Add a durable Mastodon outbound-effect ledger with idempotency keys and stale-effect quarantine
- [ ] Add operator replay/reconciliation for unknown outbound effects and YouTube writes
