import { createRequire } from "node:module";
import pino, { type DestinationStream } from "pino";

export type Logger = pino.Logger;

export type CreateLoggerOptions = {
  /** Human-readable colorized output via pino-pretty when available. */
  pretty?: boolean;
  /** Test hook: capture lines instead of writing to stdout. */
  destination?: DestinationStream;
};

/** Never let credentials reach the log stream. */
const REDACT_PATHS = [
  "token",
  "MASTODON_TOKEN",
  "mastodonToken",
  "ytCookie",
  "authorization",
  "headers.authorization",
  "req.headers.authorization",
  "*.token",
  "*.mastodonToken",
  "*.ytCookie",
];

const require = createRequire(import.meta.url);

function hasPinoPretty(): boolean {
  try {
    require.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

export function createLogger(
  level: string = "info",
  opts: CreateLoggerOptions = {},
): Logger {
  // A capture destination (tests) always wins over the NODE_ENV silent default.
  const enabled = opts.destination ? true : process.env.NODE_ENV !== "test";
  const base = {
    level,
    enabled,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  };

  if (opts.destination) {
    return pino(base, opts.destination);
  }

  // pino-pretty is a devDependency — present locally/CI, absent in the slim
  // production image. Fall back to JSON rather than crash at boot.
  if (opts.pretty && enabled && hasPinoPretty()) {
    return pino({
      ...base,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      },
    });
  }

  return pino(base);
}
