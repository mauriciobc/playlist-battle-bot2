#!/usr/bin/env bash
# Autoresearch benchmark entrypoint.
#
# Workload: `scripts/bench-sim.ts` replays the eight deterministic E2E console
# scenarios in-process (scripted votes + two fixed RNG seeds, three timed
# repeats, warmup discarded) through the real stack — poller → handlers → engine
# → store → scheduler → posts — against an in-memory SQLite and a console
# Mastodon adapter. No network, no real timers, fixed seeds.
#
# Primary metric: sim_ms — median wall time of one 24-scenario workload pass,
# lower is better. The bench exits non-zero if any scenario assertion fails or
# the pinned check count changes, so speed bought by breaking behaviour does not
# score.
#
# Gates run after the metric: a fast tree that does not typecheck, lint, or pass
# the unit suite is not a candidate.
set -euo pipefail
cd "$(dirname "$0")"

npx tsx scripts/bench-sim.ts

npm run --silent typecheck
npm run --silent lint
npm test
