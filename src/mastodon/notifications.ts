/**
 * Inbound notification classification (PRD §8 polling / cursor resume).
 * Pure classification — fetching + persistence live in the poller service.
 */

export type NotificationCursor = { lastId: string };

/** Visibilities a public command may arrive with (a DM is `direct`). */
export type PublicVisibility = "public" | "unlisted" | "private";

const PUBLIC_VISIBILITIES: readonly string[] = ["public", "unlisted", "private"] satisfies PublicVisibility[];

function isPublicVisibility(visibility: string): visibility is PublicVisibility {
  return PUBLIC_VISIBILITIES.includes(visibility);
}

type MentionStatus = {
  id: string;
  visibility: PublicVisibility | "direct" | string;
  in_reply_to_id: string | null;
  content: string;
  mentions: { id: string; username: string; acct: string }[];
};

export type RawNotification = {
  id: string;
  type: string;
  created_at: string;
  account: { id: string; acct: string; username: string };
  status: MentionStatus | null;
};

type CommandFields = {
  statusId: string;
  accountId: string;
  accountAcct: string;
  content: string;
  inReplyToId: string | null;
};

export type Classified =
  | ({ kind: "public_command"; visibility: PublicVisibility } & CommandFields)
  | ({ kind: "dm" } & CommandFields)
  | { kind: "poll_expired"; statusId: string | null };

export function classifyNotification(n: RawNotification, botAcct: string): Classified | null {
  if (n.type === "poll") {
    return { kind: "poll_expired", statusId: n.status?.id ?? null };
  }

  if (n.type !== "mention" || !n.status) return null;

  const mentioned = n.status.mentions.some(
    (mention) => mention.username.toLowerCase() === botAcct.toLowerCase(),
  );
  if (!mentioned) return null;

  const fields: CommandFields = {
    statusId: n.status.id,
    accountId: n.account.id,
    accountAcct: n.account.acct,
    content: n.status.content,
    inReplyToId: n.status.in_reply_to_id,
  };

  const { visibility } = n.status;
  if (visibility === "direct") return { kind: "dm", ...fields };
  if (!isPublicVisibility(visibility)) return null;
  return { kind: "public_command", ...fields, visibility };
}

/** Cursor only moves forward (crash-safe: advance after successful handling). */
export function advance(newId: string, cursor: NotificationCursor): NotificationCursor {
  if (cursor.lastId === "") return { lastId: newId };
  // Mastodon IDs are numeric strings — compare as BigInt when possible
  try {
    return BigInt(newId) > BigInt(cursor.lastId) ? { lastId: newId } : cursor;
  } catch {
    return newId > cursor.lastId ? { lastId: newId } : cursor;
  }
}
