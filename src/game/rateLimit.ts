import { m } from "../i18n/index.js";
import { addSeconds } from "../time.js";

/**
 * Creation rate limits (PRD §8): per-player cooldown + concurrent game cap.
 * Pure — caller supplies the account's current open games and last creation time.
 */

export class RateLimitedError extends Error {
  override readonly name = "RateLimitedError";
}

/**
 * Throws RateLimitedError if the player may not create a new game now.
 * @param lastCreationAt ISO timestamp of this player's most recent game creation, or null
 * @param openGames the player's own non-terminal games (host or participant)
 */
export function assertCanCreateGame(
  cfg: { creationCooldownSec: number; maxGamesPerPlayer: number },
  now: Date,
  lastCreationAt: string | null,
  openGames: readonly { id: string }[],
): void {
  if (openGames.length >= cfg.maxGamesPerPlayer) {
    throw new RateLimitedError(m().errConcurrentGames(openGames.length, cfg.maxGamesPerPlayer));
  }
  if (lastCreationAt === null || cfg.creationCooldownSec <= 0) return;
  const retryAt = addSeconds(new Date(lastCreationAt), cfg.creationCooldownSec);
  if (now.getTime() < retryAt.getTime()) {
    throw new RateLimitedError(m().errCooldown(retryAt.toISOString()));
  }
}
