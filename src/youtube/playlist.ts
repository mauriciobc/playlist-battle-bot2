import { m } from "../i18n/index.js";
import { MIN_QUEUE_TUNES, resolveQueueUrl } from "./queue.js";
import {
  YtMusicPlaylistClient,
  YtMusicError,
  type PlaylistPrivacy,
  type YtMusicAuth,
} from "./ytmusic.js";

/**
 * The battle's tunes as one shareable link (PRD §5.7 finale).
 *
 * With a bot-account cookie configured this publishes a real playlist to the
 * account's library; without one it falls back to an anonymous YouTube queue.
 * Either way it is best-effort: a finale must post even when YouTube does not
 * cooperate, so failures are logged and degrade to `null`, never thrown.
 */

export type BattlePlaylistTune = { round: number; videoId: string };

export type BattlePlaylistInput = {
  theme: string;
  rounds: number;
  /** Round-winning tunes in round order. */
  tunes: BattlePlaylistTune[];
  /**
   * Playlist created by an earlier attempt that did not finish (crash resume):
   * it is reused rather than created twice.
   */
  existingPlaylistId: string | null;
};

export type BattlePlaylistLink = {
  url: string;
  /** Set for an account playlist, null for an anonymous queue link. */
  playlistId: string | null;
};

export type BattlePlaylistPublisher = (input: BattlePlaylistInput) => Promise<BattlePlaylistLink | null>;

export type BattlePlaylistPublisherOptions = {
  /** Absent → anonymous queue links only. */
  auth?: YtMusicAuth | null;
  privacy?: PlaylistPrivacy;
  fetchImpl?: typeof fetch;
  log?: (message: string, detail?: unknown) => void;
};

export const YT_MUSIC_PLAYLIST_URL = "https://music.youtube.com/playlist?list=";

/** YT Music drops playlist metadata containing angle brackets; titles cap at 150 chars. */
const TITLE_LIMIT = 120;
const DESCRIPTION_LIMIT = 400;

/** Strip markup characters YouTube rejects and clamp to `max` characters. */
export function sanitizePlaylistText(text: string, max: number): string {
  const cleaned = text
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1).trimEnd()}…`;
}

export function createBattlePlaylistPublisher(
  opts: BattlePlaylistPublisherOptions = {},
): BattlePlaylistPublisher {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const client = opts.auth
    ? new YtMusicPlaylistClient({ auth: opts.auth, fetchImpl })
    : null;
  const privacy = opts.privacy ?? "PUBLIC";

  return async (input) => {
    // Cross-round collisions are legal (two players may field the same video in
    // different rounds), but the write path dedupes by video ID: a repeated ID
    // makes YouTube reject the whole batch.
    const videoIds = [...new Set(input.tunes.map((t) => t.videoId))];
    if (videoIds.length < MIN_QUEUE_TUNES) return null;

    if (client) {
      try {
        const playlistId =
          input.existingPlaylistId ??
          (await client.createPlaylist({
            title: sanitizePlaylistText(m().playlistTitle(input.theme, input.rounds), TITLE_LIMIT),
            description: sanitizePlaylistText(
              m().playlistDescription(input.theme, input.rounds),
              DESCRIPTION_LIMIT,
            ),
            privacy,
          }));
        // A resumed playlist keeps whatever tracks it already has: adding again
        // would either duplicate them or be rejected as a batch.
        if (!input.existingPlaylistId) await client.addTracks(playlistId, videoIds);
        return { url: `${YT_MUSIC_PLAYLIST_URL}${playlistId}`, playlistId };
      } catch (err) {
        opts.log?.(
          "could not publish the finale playlist to the YouTube Music account",
          err instanceof YtMusicError ? err.kind : err,
        );
      }
    }

    const url = await resolveQueueUrl(videoIds, { fetchImpl });
    return url ? { url, playlistId: null } : null;
  };
}
