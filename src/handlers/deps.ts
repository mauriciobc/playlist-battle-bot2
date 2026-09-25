import type { Db } from "../db/index.js";
import type { MastodonClient } from "../mastodon/client.js";
import type { PublicVisibility } from "../mastodon/notifications.js";
import type { Logger } from "../logger.js";
import type { ResolvedTune } from "../youtube/oembed.js";
import type { BattlePlaylistPublisher } from "../youtube/playlist.js";

/** Everything the handlers and the scheduler need from the outside world. */
export type HandlerDeps = {
  db: Db;
  client: MastodonClient;
  botAcct: string;
  instanceDomain: string;
  pollDurationSec: number;
  acceptanceWindowSec: number;
  submissionWindowSec: number;
  creationCooldownSec: number;
  maxGamesPerPlayer: number;
  lookup: (acct: string) => Promise<{ id: string; acct: string }>;
  resolveTitle: (videoId: string) => Promise<ResolvedTune>;
  /** Live availability check for a video (never reads the title cache). */
  checkAvailable: (videoId: string) => Promise<boolean>;
  /**
   * Publishes the battle's round-winning tunes as one shareable link — a real
   * YT Music playlist when the bot account is configured, otherwise an
   * anonymous YouTube queue — or null when nothing could be published.
   * Best-effort by contract: it never throws, so the finale posts regardless.
   */
  publishBattlePlaylist: BattlePlaylistPublisher;
  /** Replacement window for unavailable round tunes (v1.1 1.4). */
  replacementGraceMin: number;
  now: () => Date;
  newGameId: () => string;
  /**
   * Fast path for poll-expiry notifications, injected by the runtime so the
   * handler layer never imports the scheduler (keeps the dependency graph
   * acyclic). When unset, the scheduler's periodic sweep still resolves the poll.
   */
  onPollExpired?: (statusId: string | null) => Promise<void>;
  /**
   * Structured logger. Unexpected errors whose text must never reach a player
   * (oEmbed/SQLite internals) are logged here instead. Optional so tests can omit it.
   */
  logger?: Logger;
};

/** A mention or DM addressed to the bot. */
export type CommandInput = {
  accountId: string;
  accountAcct: string;
  statusId: string;
  content: string;
  inReplyToId: string | null;
  visibility?: PublicVisibility;
};

export type Handled = { handled: true; kind: string; detail?: unknown };

export type HandlerResult = { handled: false; reason: string } | Handled;
