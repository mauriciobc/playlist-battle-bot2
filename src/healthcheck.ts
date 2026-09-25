import Database from "better-sqlite3";
import { LOOP_LABELS } from "./game/store.js";

const path = process.env.DB_PATH ?? "./data/bot.db";
const db = new Database(path, { readonly: true, fileMustExist: true });
const rows = db
  .prepare(
    `SELECT loop, last_success_at FROM loop_heartbeats WHERE loop IN (${LOOP_LABELS.map(() => "?").join(", ")})`,
  )
  .all(...LOOP_LABELS) as { loop: string; last_success_at: string }[];
const now = Date.now();
/** A loop that has not succeeded in ten minutes is stuck. */
const healthy = LOOP_LABELS.every((loop) => {
  const row = rows.find((candidate) => candidate.loop === loop);
  const last = row?.last_success_at ? Date.parse(row.last_success_at) : NaN;
  return Number.isFinite(last) && now - last <= 10 * 60 * 1000;
});
db.close();

if (!healthy) process.exit(1);
