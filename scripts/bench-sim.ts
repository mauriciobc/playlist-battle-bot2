/**
 * Autoresearch benchmark — replays the deterministic E2E console scenarios
 * in-process and reports what the bot's own work costs.
 *
 *   npm run bench:sim
 *
 * The workload is the same eight game scenarios the console harness asserts on,
 * run once with their scripted vote vectors and once per fixed seed with the
 * harness RNG (`null` votes → mulberry32(seed)), repeated a fixed number of
 * times. Nothing is printed while the clock runs, so the metric measures the
 * real stack (poller → handlers → engine → store → scheduler → posts) and not
 * terminal I/O.
 *
 * Primary metric `sim_ms` is the FASTEST timed repeat, in milliseconds. The
 * workload is compute-bound (in-memory SQLite, no network, no real timers), so
 * its cost has a hard floor and the fastest sample is the one least polluted by
 * scheduler interference: across runs it reproduces far better than the median,
 * which wanders with whatever else the machine is doing. The median, the worst
 * repeat and process CPU time are reported for reference.
 *
 * Every scenario's assertions still run: any failing check, thrown scenario, or
 * repeat whose check count drifts from EXPECTED_CHECKS exits non-zero and
 * invalidates the run.
 */

import { performance } from "node:perf_hooks";

import { migrate, openDatabase, type Db } from "../src/db/index.js";
import { setLocale } from "../src/i18n/index.js";
import { Harness, SCENARIOS, type Scenario } from "./e2e-console.js";

/** Discarded repeats, to let the JIT settle before measurement. */
const WARMUP_REPEATS = 2;
/**
 * Timed repeats. The metric is their fastest, so the count is set by how many
 * samples it takes for an uninterrupted one to appear, balanced against
 * keeping a run to a few seconds.
 */
const TIMED_REPEATS = 15;
/** RNG-fuzz passes: votes are drawn from mulberry32(seed). */
const RANDOM_SEEDS = [7, 42, 2024];
/**
 * Checks the fixed workload must produce (113–114 per pass, depending on the
 * seed's finale assertions, × 4 passes). Pinned so that weakening an assertion
 * cannot buy speed: the run fails when it changes.
 */
const EXPECTED_CHECKS = 455;

type Pass = { label: string; random: boolean; seed: number };

const PASSES: Pass[] = [
  { label: "scripted", random: false, seed: 0 },
  ...RANDOM_SEEDS.map((seed) => ({ label: `random-${seed}`, random: true, seed })),
];

type PassResult = { label: string; ms: number; cpuMs: number; checks: number; failed: number; errors: string[] };
type RepeatResult = PassResult & { passes: PassResult[] };

/** Microseconds of process CPU (user + system) consumed by one synchronously-awaited call. */
function cpuUs(): number {
  const usage = process.cpuUsage();
  return usage.user + usage.system;
}

/** One scenario: the game itself is measured, the assertions that follow are not. */
async function runScenario(connection: Db, pass: Pass, scenario: Scenario): Promise<PassResult> {
  const votes = pass.random ? null : scenario.votes;
  const h = new Harness(votes, pass.seed, scenario.expectedStatuses ?? [], connection);
  const errors: string[] = [];
  const cpuStart = cpuUs();
  const started = performance.now();
  try {
    await scenario.run(h);
  } catch (err) {
    errors.push(
      `${pass.label}/${scenario.label} threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    h.check("scenario ran to completion", false, err instanceof Error ? err.message : String(err));
  }
  const ms = performance.now() - started;
  const cpuMs = (cpuUs() - cpuStart) / 1000;
  h.reconcile();
  const failed = h.checks.filter((c) => !c.ok);
  const failedDetails = failed.map((c) => `${pass.label}/${scenario.label} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  const result: PassResult = {
    label: `${pass.label}/${scenario.label}`,
    ms,
    cpuMs,
    checks: h.checks.length,
    failed: failed.length,
    errors: [...errors, ...failedDetails],
  };
  h.close();
  return result;
}

async function runPass(connection: Db, pass: Pass): Promise<PassResult> {
  const results: PassResult[] = [];
  for (const scenario of SCENARIOS) results.push(await runScenario(connection, pass, scenario));
  return {
    label: pass.label,
    ms: sum(results, (r) => r.ms),
    cpuMs: sum(results, (r) => r.cpuMs),
    checks: sum(results, (r) => r.checks),
    failed: sum(results, (r) => r.failed),
    errors: results.flatMap((r) => r.errors),
  };
}

async function runRepeat(connection: Db): Promise<RepeatResult> {
  const passes: PassResult[] = [];
  for (const pass of PASSES) passes.push(await runPass(connection, pass));
  return {
    label: "repeat",
    ms: sum(passes, (p) => p.ms),
    cpuMs: sum(passes, (p) => p.cpuMs),
    checks: sum(passes, (p) => p.checks),
    failed: sum(passes, (p) => p.failed),
    errors: passes.flatMap((p) => p.errors),
    passes,
  };
}

function sum<T>(items: T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const low = sorted[mid - 1];
  const high = sorted[mid];
  if (low === undefined || high === undefined) return sorted[0] ?? Number.NaN;
  return sorted.length % 2 === 1 ? high : (low + high) / 2;
}

/** The harness narrates every event; the benchmark does not need that detail. */
function silenceStdout(): () => void {
  const original = console.log;
  console.log = () => {};
  return () => {
    console.log = original;
  };
}

function spread(values: number[]): string {
  return values.map((v) => v.toFixed(1)).join(", ");
}

async function bench(): Promise<number> {
  setLocale("en");
  const games = PASSES.length * SCENARIOS.length;
  const quiet = silenceStdout();
  const warmup: RepeatResult[] = [];
  const timed: RepeatResult[] = [];
  let connection: Db | null = null;
  try {
    // One long-lived connection for the whole run, as the bot itself has: the
    // warmup repeat compiles every statement the scenarios use, so the timed
    // repeats measure the bot's work and not SQLite's parse of it.
    connection = openDatabase(":memory:");
    migrate(connection);
    for (let i = 0; i < WARMUP_REPEATS; i += 1) warmup.push(await runRepeat(connection));
    for (let i = 0; i < TIMED_REPEATS; i += 1) timed.push(await runRepeat(connection));
  } finally {
    connection?.close();
    quiet();
  }

  const all = [...warmup, ...timed];
  const errors = all.flatMap((r) => r.errors);
  const drift = all.filter((r) => r.checks !== EXPECTED_CHECKS);
  const failures = sum(all, (r) => r.failed);
  const cpu = timed.map((r) => r.cpuMs);
  const wall = timed.map((r) => r.ms);
  /** Fastest repeat: the sample least polluted by scheduler interference. */
  const simMs = Math.min(...wall);
  const cpuMs = Math.min(...cpu);

  console.log(`workload  ${games} scenarios/repeat (${PASSES.map((p) => p.label).join(", ")}) × ${TIMED_REPEATS} repeats`);
  for (const [index, repeat] of all.entries()) {
    const stage = index < warmup.length ? "warmup" : "timed ";
    console.log(
      `  ${stage} cpu ${repeat.cpuMs.toFixed(1)} ms · wall ${repeat.ms.toFixed(1)} ms · ${repeat.checks} checks · ${repeat.failed} failed`,
    );
  }
  console.log(`  cpu_ms spread  ${spread(cpu)}`);
  console.log(`  sim_ms spread  ${spread(wall)}`);

  console.log(`METRIC sim_ms=${simMs.toFixed(3)}`);
  console.log(`METRIC sim_ms_median=${median(wall).toFixed(3)}`);
  console.log(`METRIC sim_ms_max=${Math.max(...wall).toFixed(3)}`);
  console.log(`METRIC ms_per_game=${(simMs / games).toFixed(4)}`);
  console.log(`METRIC cpu_ms=${cpuMs.toFixed(3)}`);
  console.log(`METRIC cpu_ms_median=${median(cpu).toFixed(3)}`);
  console.log(`METRIC cpu_ms_max=${Math.max(...cpu).toFixed(3)}`);
  console.log(`METRIC games=${games}`);
  console.log(`METRIC checks=${timed[0]?.checks ?? 0}`);
  console.log(`METRIC checks_failed=${failures}`);
  for (const [index, pass] of PASSES.entries()) {
    const key = pass.label.replace(/-/g, "_");
    const passCpu = Math.min(...timed.map((r) => r.passes[index]?.cpuMs ?? Number.NaN));
    const passWall = Math.min(...timed.map((r) => r.passes[index]?.ms ?? Number.NaN));
    console.log(`METRIC cpu_ms_${key}=${passCpu.toFixed(3)}`);
    console.log(`METRIC sim_ms_${key}=${passWall.toFixed(3)}`);
    console.log(`  pass ${pass.label}: cpu ${passCpu.toFixed(1)} ms · wall ${passWall.toFixed(1)} ms`);
  }

  if (errors.length > 0) {
    console.error(`bench: ${errors.length} scenario failure(s):`);
    for (const err of errors.slice(0, 20)) console.error(`  ${err}`);
  }
  if (drift.length > 0) {
    console.error(
      `bench: workload changed — expected ${EXPECTED_CHECKS} checks per repeat, saw ` +
        `${drift.map((r) => r.checks).join(", ")} (assertions must not be weakened)`,
    );
  }
  if (failures > 0 || errors.length > 0 || drift.length > 0) return 1;
  return 0;
}

bench()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
