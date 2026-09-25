import type { MastodonClient, RequestOptions } from "./client.js";
import type { Game, Player, PotSplit, Tally, Tune } from "../game/types.js";
import {
  abbreviatePollOption,
  assertPostLength,
  dedupePollOptions,
  sanitizeTitleForPost,
  truncate,
  truncatePostWithSuffix,
} from "../templates/truncate.js";
import { m } from "../i18n/index.js";
import { byStanding, totalVotes } from "../game/scoring.js";

/**
 * Outbound Mastodon posting: round threads, polls, resolution, finale, side effects.
 * All content asserted ≤500 chars (PRD §8).
 */

export type PostRoundResult = {
  pollStatusId: string;
  pollId: string;
  pollExpiresAt: string;
  /** poll option index (string) → accountId */
  optionMap: Record<string, string>;
};

async function postStatus(
  client: MastodonClient,
  body: { status: string; in_reply_to_id?: string; poll?: unknown },
  options: RequestOptions = {},
): Promise<{ id: string; poll?: { id: string; expires_at?: string } }> {
  assertPostLength(body.status);
  // Key order is part of the outbox ledger's idempotency check: keep it stable.
  const payload: Record<string, unknown> = { status: body.status, visibility: "public" };
  if (body.in_reply_to_id) payload.in_reply_to_id = body.in_reply_to_id;
  if (body.poll) payload.poll = body.poll;
  return client.post<{ id: string; poll?: { id: string; expires_at?: string } }>(
    "/api/v1/statuses",
    payload,
    options,
  );
}

function acctOf(players: Player[], accountId: string): string {
  return players.find((p) => p.accountId === accountId)?.acct ?? accountId;
}

/** `@alice 3 · @bob 1`, in the order given. */
function standings(players: Player[]): string {
  return players.map((p) => `@${p.acct} ${p.points}`).join(" · ");
}

function roundKey(gameId: string, round: number, part: string): string {
  return `pb:v1:round:${gameId}:${round}:${part}`;
}

function finaleKey(gameId: string, part: string): string {
  return `pb:v1:finale:${gameId}:${part}`;
}

/**
 * Post one round: announce → per-player tune replies → poll (PRD §5.5).
 * Players already filtered by eligibility upstream; tunes are this round's tunes in post order.
 */
export async function postRound(
  client: MastodonClient,
  game: Game,
  players: Player[],
  roundTunes: Tune[],
  round: number,
): Promise<PostRoundResult> {
  const playing = players.filter((p) => roundTunes.some((t) => t.accountId === p.accountId));

  const announceText = truncate(m().roundAnnounce(
    round,
    game.playlistLength,
    game.theme,
    standings(players),
    game.pot,
    playing.map((p) => `@${p.acct}`).join(", "),
  ));

  const announce = await postStatus(client, {
    status: announceText,
    in_reply_to_id: game.threadRootId ?? game.id,
  }, { idempotencyKey: roundKey(game.id, round, "announce") });

  let prevId = announce.id;
  for (const [tuneIndex, t] of roundTunes.entries()) {
    // Sanitize the displayed title so an embedded URL inside it can't steal
    // Mastodon's preview card (first URL in text wins) from the canonical
    // YouTube link, which is what produces the video embed.
    const text = truncatePostWithSuffix(
      m().tuneLine(acctOf(players, t.accountId), sanitizeTitleForPost(t.title)),
      t.canonicalUrl,
    );
    const posted = await postStatus(
      client,
      { status: text, in_reply_to_id: prevId },
      { idempotencyKey: roundKey(game.id, round, `tune:${tuneIndex}`) },
    );
    prevId = posted.id;
  }

  // Poll: one option per playing player, ≤25 chars each (PRD §2.2/§2.3).
  // Mastodon enforces ≤50 chars, ≤4 options, and UNIQUENESS (422 otherwise),
  // so dedupe after truncation.
  const optionMap: Record<string, string> = {};
  const options = dedupePollOptions(
    roundTunes.map((t, i) => {
      optionMap[String(i)] = t.accountId;
      return abbreviatePollOption(acctOf(players, t.accountId), t.title);
    }),
  );

  const pollBody = await postStatus(client, {
    status: m().pollPrompt(round),
    in_reply_to_id: prevId,
    poll: {
      options,
      expires_in: game.pollDurationSec,
      multiple: false,
      hide_totals: false,
    },
  }, { idempotencyKey: roundKey(game.id, round, "poll") });

  const poll = pollBody.poll;
  if (!poll?.id || !poll.expires_at || Number.isNaN(Date.parse(poll.expires_at))) {
    throw new Error("Mastodon poll response did not include a valid poll id and expiry");
  }

  return {
    pollStatusId: pollBody.id,
    pollId: poll.id,
    pollExpiresAt: poll.expires_at,
    optionMap,
  };
}

export type TallyInput = {
  round: number;
  winnerAcct: string | null;
  potAwarded: number;
  wasTie: boolean;
  newPot?: number;
  walkover?: boolean;
  /** v1.1 1.3: final-round pot split meta (present only on a split tie). */
  potSplit?: PotSplit | null;
};

export async function postRoundResolution(
  client: MastodonClient,
  game: Game,
  players: Player[],
  input: TallyInput,
): Promise<string> {
  const lines: string[] = [];
  if (input.walkover) {
    lines.push(
      m().resolutionWalkover(input.round, input.winnerAcct ?? "?", input.potAwarded),
    );
  } else if (input.potSplit && input.potSplit.total > 0) {
    lines.push(
      m().resolutionFinalTie(input.round, input.potSplit.total, input.potSplit.each),
    );
  } else if (input.wasTie) {
    lines.push(
      m().resolutionTie(input.round, input.newPot ?? game.pot),
    );
  } else if (input.winnerAcct) {
    lines.push(m().resolutionWin(input.round, input.winnerAcct, input.potAwarded));
  }

  lines.push(m().standingsLine(standings([...players].sort(byStanding))));
  const potAfter = input.newPot ?? game.pot;
  if (input.newPot !== undefined || game.pot > 0 || input.wasTie) {
    lines.push(m().potLine(potAfter));
  }

  const posted = await postStatus(client, {
    status: truncate(lines.join("\n")),
    in_reply_to_id: game.threadRootId ?? game.id,
  }, { idempotencyKey: roundKey(game.id, input.round, "result") });
  return posted.id;
}

export type FinaleTune = {
  round: number;
  accountId: string;
  videoId: string;
  title: string;
  canonicalUrl: string;
};

/**
 * Post finale in a NEW thread (PRD §5.7): summary root (no in_reply_to),
 * then one reply per winning tune.
 * Returns the summary status ID.
 */
export async function postFinale(
  client: MastodonClient,
  game: Game,
  players: Player[],
  champions: string[],
  winningTunes: FinaleTune[],
  opts: {
    duelThreadId: string | null;
    potSplit: PotSplit | null;
    /** Battle playlist/queue link; null when publishing failed. */
    queueUrl: string | null;
  },
): Promise<string> {
  const ordered = [...players].sort(byStanding);
  const champHandles = champions.map((id) => `@${acctOf(players, id)}`);

  const lines: string[] = [];
  if (champions.length > 1) {
    lines.push(m().sharedChampionship(champHandles.join(" & ")));
  } else if (champions.length === 1) {
    lines.push(m().champion(champHandles[0]!));
  }
  lines.push(m().finaleTheme(game.theme, game.playlistLength));
  lines.push(m().finaleStandings(standings(ordered)));
  if (opts.potSplit && opts.potSplit.total > 0) {
    lines.push(m().finalePotSplit(opts.potSplit.total, opts.potSplit.each, opts.potSplit.count));
  }
  if (opts.duelThreadId) lines.push(m().finaleDuelLink(opts.duelThreadId));

  const summary = await postStatus(
    client,
    { status: truncate(lines.join("\n")) },
    { idempotencyKey: finaleKey(game.id, "summary") },
  );

  // First reply: the whole battle as one link, before the per-round winners.
  if (opts.queueUrl) {
    await postStatus(
      client,
      { status: truncatePostWithSuffix(m().finaleQueue(), opts.queueUrl), in_reply_to_id: summary.id },
      { idempotencyKey: finaleKey(game.id, "queue") },
    );
  }

  for (const [tuneIndex, t] of winningTunes.entries()) {
    const text = truncatePostWithSuffix(
      m().finaleWinningTune(t.round, acctOf(players, t.accountId), sanitizeTitleForPost(t.title)),
      t.canonicalUrl,
    );
    await postStatus(
      client,
      { status: text, in_reply_to_id: summary.id },
      { idempotencyKey: finaleKey(game.id, `tune:${tuneIndex}`) },
    );
  }

  return summary.id;
}

export type SideEffectKind = "expired" | "fizzled" | "forfeit" | "cancelled" | "default_win";

const SIDE_EFFECT_COPY: Record<SideEffectKind, (g: Game, winnerAcct?: string) => string> = {
  expired: (g) => m().sideExpired(g.theme),
  fizzled: (g) => m().sideFizzled(g.theme),
  forfeit: (g) => m().sideForfeit(g.theme),
  cancelled: (g) => m().sideCancelled(g.theme),
  default_win: (g, winnerAcct) => m().sideDefaultWin(g.theme, winnerAcct ?? "?"),
};

/** Reply closure/default outcome on the creation thread. */
export async function postSideEffect(
  client: MastodonClient,
  game: Game,
  kind: SideEffectKind,
  winnerAcct?: string,
): Promise<string> {
  const text = SIDE_EFFECT_COPY[kind](game, winnerAcct);
  const posted = await postStatus(
    client,
    { status: text, in_reply_to_id: game.threadRootId ?? game.id },
    { idempotencyKey: `pb:v1:game:${game.id}:side:${kind}` },
  );
  return posted.id;
}

/** Fetch expired poll tallies and map option indices → accountId votes. */
export async function tallyPoll(
  client: MastodonClient,
  pollId: string,
  optionMap: Record<string, string>,
): Promise<Tally[]> {
  const poll = await client.get<{
    expired: boolean;
    options: { title: string; votes_count: number }[];
  }>(`/api/v1/polls/${pollId}`);

  if (poll.expired !== true) {
    throw new Error("Mastodon poll is not expired");
  }
  if (!Array.isArray(poll.options) || poll.options.length !== Object.keys(optionMap).length) {
    throw new Error("Mastodon poll options do not match the stored round map");
  }
  const tallies: Tally[] = [];
  poll.options.forEach((opt, idx) => {
    const accountId = optionMap[String(idx)];
    if (!accountId || !Number.isInteger(opt.votes_count) || opt.votes_count < 0) {
      throw new Error("Mastodon poll response contains an invalid option tally");
    }
    tallies.push({ accountId, votes: opt.votes_count });
  });
  return tallies;
}

export type PollSnapshot = {
  tallies: Tally[];
  totalVotes: number;
};

/**
 * Live poll snapshot for stagnation early-close decisions (poll not yet expired).
 * Returns null when tallies are hidden (hide_totals before expiry) — early close
 * needs visible counts to make a trustworthy call.
 */
export async function pollSnapshot(
  client: MastodonClient,
  pollId: string,
  optionMap: Record<string, string>,
): Promise<PollSnapshot | null> {
  const poll = await client.get<{
    options: { title: string; votes_count: number | null }[];
  }>(`/api/v1/polls/${pollId}`);

  if (!Array.isArray(poll.options) || poll.options.length !== Object.keys(optionMap).length) {
    return null;
  }

  const tallies: Tally[] = [];
  for (const [idx, opt] of poll.options.entries()) {
    const votes = opt.votes_count;
    if (votes === null || votes === undefined) return null;
    const accountId = optionMap[String(idx)];
    if (!accountId) return null;
    tallies.push({ accountId, votes });
  }
  return { tallies, totalVotes: totalVotes(tallies) };
}
