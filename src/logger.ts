import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(level: string = "info"): Logger {
  return pino({
    level,
    ...(process.env.NODE_ENV === "test" ? { enabled: false } : {}),
  });
}
