/**
 * Shared plumbing for the mock-Mastodon contract specs under tests/.
 */
import { MockMastodonServer } from "./mock-mastodon.js";

export type Json = Record<string, unknown>;

/** The bot's bearer: MockMastodonServer's default token. */
export const AUTH = { Authorization: "Bearer mock-token" };

export const jsonOf = async (res: Response) => (await res.json()) as Json;

/**
 * A running mock with bot@, host@ and player@mock.social. Host and player get
 * their own tokens so they can author statuses: a mention notification goes
 * to the mentioned account, never to its author, so the bot's token alone
 * cannot produce one.
 */
export async function startMock(): Promise<MockMastodonServer> {
  const server = new MockMastodonServer({
    botAcct: "bot@mock.social",
    hostAcct: "host@mock.social",
    playerAcct: "player@mock.social",
  });
  server.registerToken("host-token", "host@mock.social");
  server.registerToken("player-token", "player@mock.social");
  await server.start();
  return server;
}

/** POST a JSON body to the mock as `token` (default: the bot). */
export function postJson(
  server: MockMastodonServer,
  path: string,
  body: Json,
  token = "mock-token",
): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Create a status as `token` (default: the bot) and return its JSON. */
export async function post(server: MockMastodonServer, body: Json, token?: string): Promise<Json> {
  return jsonOf(await postJson(server, "/api/v1/statuses", body, token));
}
