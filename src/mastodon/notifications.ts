/**
 * Inbound notification classification (PRD §8 polling / cursor resume).
 * Pure classification — fetching + persistence live in the poller service.
 */

export type NotificationCursor = { lastId: string };

export type MentionStatus = {
  id: string;
  visibility: "public" | "unlisted" | "private" | "direct" | string;
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

export type Classified =
  | {
      kind: "public_command";
      statusId: string;
      accountId: string;
      accountAcct: string;
       content: string;
       inReplyToId: string | null;
       visibility: "public" | "unlisted" | "private";
     }
   | {
       kind: "dm";
      statusId: string;
      accountId: string;
      accountAcct: string;
      content: string;
      inReplyToId: string | null;
    }
  | { kind: "poll_expired"; statusId: string | null };

export function classifyNotification(n: RawNotification, botAcct: string): Classified | null {
  if (n.type === "poll") {
    return { kind: "poll_expired", statusId: n.status?.id ?? null };
  }

  if (n.type !== "mention" || !n.status) return null;

  const mentioned = n.status.mentions.some(
    (m) => m.username.toLowerCase() === botAcct.toLowerCase(),
  );
  if (!mentioned) return null;

  const base = {
    statusId: n.status.id,
    accountId: n.account.id,
    accountAcct: n.account.acct,
    content: n.status.content,
    inReplyToId: n.status.in_reply_to_id,
  };

  if (n.status.visibility === "direct") {
    return { kind: "dm", ...base };
  }
  if (
    n.status.visibility !== "public" &&
    n.status.visibility !== "unlisted" &&
    n.status.visibility !== "private"
  ) {
    return null;
  }
  return { kind: "public_command", ...base, visibility: n.status.visibility };
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
