import type { MastodonClient, RequestOptions } from "./client.js";
import type { PublicVisibility } from "./notifications.js";
import { assertPostLength } from "../templates/truncate.js";

/** Reply to a status; returns the reply's status ID. */
export async function reply(
  deps: { client: MastodonClient },
  inReplyToId: string,
  text: string,
  visibility: PublicVisibility = "public",
  options: RequestOptions = {},
): Promise<string> {
  assertPostLength(text);
  const status = await deps.client.post<{ id: string }>("/api/v1/statuses", {
    status: text,
    in_reply_to_id: inReplyToId,
    visibility,
  }, options);
  return status.id;
}
