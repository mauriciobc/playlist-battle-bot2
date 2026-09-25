import Database from "better-sqlite3";
import { LOOP_LABELS, loopHeartbeats } from "./db/heartbeats.js";
import { MS_PER_SECOND, SECONDS_PER_MINUTE } from "./time.js";

/** A loop that has not succeeded in ten minutes is stuck. */
const STALE_AFTER_MS = 10 * SECONDS_PER_MINUTE * MS_PER_SECOND;

const path = process.env.DB_PATH ?? "./data/bot.db";
const db = new Database(path, { readonly: true, fileMustExist: true });
const lastSuccess = loopHeartbeats(db);
const now = Date.now();
const healthy = LOOP_LABELS.every((loop) => {
  const last = Date.parse(lastSuccess.get(loop) ?? "");
  return Number.isFinite(last) && now - last <= STALE_AFTER_MS;
});
db.close();

if (!healthy) process.exit(1);
