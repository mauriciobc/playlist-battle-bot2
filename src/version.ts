import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };

/** Semver from package.json — identifies the release line. */
export const APP_VERSION: string = pkg.version ?? "0.0.0";

/**
 * Build identity: baked into the Docker image as ARG GIT_SHA, overridable at
 * runtime via the GIT_SHA env var (stack.env / .env). Falls back to "dev"
 * for local runs where neither is set.
 */
export const GIT_SHA: string = process.env.GIT_SHA?.trim() || "dev";

/** Single-line stamp for startup logs: "0.1.0 (f424ab2)". */
export const VERSION_STAMP: string = `${APP_VERSION} (${GIT_SHA})`;
