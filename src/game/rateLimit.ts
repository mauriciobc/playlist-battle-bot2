import { m } from "../i18n/index.js";

/**
 * Creation rate limits (PRD §8): per-player cooldown + concurrent game cap.
 * Pure — caller supplies the account's current open games and last creation time.
 */

export class RateLimitedError extends Error {
  override readonly name = "RateLimitedError";
  readonly reason: "cooldown" | "concurrent";
  readonly retryAt: string | null;

  constructor(reason: "cooldown" | "concurrent", message: string, retryAt: string | null = null) {
    super(message);
    this.reason = reason;
    this.retryAt = retryAt;
  }
}

export type RateLimitConfig = {
  creationCooldownSec: number;
  maxGamesPerPlayer: number;
};

/**
 * Throws RateLimitedError if the player may not create a new game now.
 * @param lastCreationAt ISO timestamp of this player's most recent game creation, or null
 * @param openGames the player's own non-terminal games (host or participant)
 */
export function assertCanCreateGame(
  cfg: RateLimitConfig,
  now: Date,
  lastCreationAt: string | null,
  openGames: readonly { id: string }[],
): void {
  const concurrent = openGames.length;
  if (concurrent >= cfg.maxGamesPerPlayer) {
    throw new RateLimitedError(
      "concurrent",
      m().errConcurrentGames(concurrent, cfg.maxGamesPerPlayer),
    );
  }

  if (lastCreationAt !== null && cfg.creationCooldownSec > 0) {
    const elapsed = (now.getTime() - new Date(lastCreationAt).getTime()) / 1000;
    if (elapsed < cfg.creationCooldownSec) {
      const retryAt = new Date(
        new Date(lastCreationAt).getTime() + cfg.creationCooldownSec * 1000,
      ).toISOString();
      throw new RateLimitedError(
        "cooldown",
        m().errCooldown(retryAt),
        retryAt,
      );
    }
  }
}
