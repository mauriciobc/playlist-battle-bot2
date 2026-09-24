import { describe, it, expect, beforeEach } from "vitest";
import { MockMastodonServer } from "../test/integration/mock-mastodon.js";

/**
 * These cases are transcribed from Mastodon's own request specs, not from my
 * reading of the serializers. The specs are the authority on behaviour, and
 * mirroring them is what keeps the mock honest:
 *
 *   spec/requests/api/v1/polls/votes_spec.rb
 *     - creates a vote; choices: %w(1)  <- a STRING, not an integer
 *     - cached_tallies becomes [0, 1]
 *     - missing choices -> 400
 *   spec/requests/api/v1/polls_spec.rb
 *     - 200 with id, voted, voters_count, votes_count
 *     - parent status private -> 404
 *   spec/requests/api/v1/conversations_spec.rb
 *     - returns pagination headers
 *     - 2 conversations, and accounts.size == 1 when the DM mentions nobody
 *     - since_id older than everything -> everything
 *     - since_id in the future -> none
 *
 * Every assertion below names the upstream spec it came from.
 */

const AUTH = { Authorization: "Bearer mock-token" };
type Json = Record<string, unknown>;
const jsonOf = async (res: Response) => (await res.json()) as Json;

async function start() {
  const server = new MockMastodonServer({
    botAcct: "bot@mock.social",
    hostAcct: "host@mock.social",
    playerAcct: "player@mock.social",
  });
  await server.start();
  return server;
}

async function post(server: MockMastodonServer, body: Json): Promise<Json> {
  const res = await fetch(`${server.baseUrl}/api/v1/statuses`, {
    method: "POST",
    headers: { ...AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return jsonOf(res);
}

describe("upstream: POST /api/v1/polls/:poll_id/votes (polls/votes_spec.rb)", () => {
  let server: MockMastodonServer;
  beforeEach(async () => {
    server = await start();
  });

  it("creates a vote with choices as strings, and tallies it", async () => {
    // upstream: let(:params) { { choices: %w(1) } }
    const created = await post(server, {
      status: "poll",
      poll: { options: ["a", "b"], expires_in: 300 },
    });
    const pollId = ((created.poll ?? {}) as Json).id as string;
    const res = await fetch(`${server.baseUrl}/api/v1/polls/${pollId}/votes`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ choices: ["1"] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await jsonOf(res);
    // upstream: expect(poll.reload.cached_tallies).to eq [0, 1]
    expect((body.options as Array<{ votes_count: number }>).map((o) => o.votes_count)).toEqual([
      0, 1,
    ]);
    expect(body.votes_count).toBe(1);
    expect(body.voted).toBe(true);
  });

  it("returns 400 when the required choices param is not provided", async () => {
    // upstream: context 'when the required choices param is not provided'
    const created = await post(server, {
      status: "poll",
      poll: { options: ["a", "b"], expires_in: 300 },
    });
    const pollId = ((created.poll ?? {}) as Json).id as string;
    const res = await fetch(`${server.baseUrl}/api/v1/polls/${pollId}/votes`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("upstream: GET /api/v1/polls/:id (polls_spec.rb)", () => {
  let server: MockMastodonServer;
  beforeEach(async () => {
    server = await start();
  });

  it("returns poll data with id, voted, voters_count and votes_count", async () => {
    // upstream: expect(response.parsed_body).to match a hash_including(...)
    const created = await post(server, {
      status: "poll",
      poll: { options: ["a", "b"], expires_in: 300 },
    });
    const pollId = ((created.poll ?? {}) as Json).id as string;
    const res = await fetch(`${server.baseUrl}/api/v1/polls/${pollId}`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await jsonOf(res);
    expect(body.id).toBe(pollId);
    expect(body.voted).toBe(false);
    expect(body.voters_count).toBe(0);
    expect(body.votes_count).toBe(0);
  });

  it.skip("returns 404 when the parent status is private - UNRESOLVED", async () => {
    // upstream: context 'when parent status is private' -> returns http not found
    //
    // Left skipped on purpose. polls_spec's private context reuses the public
    // subject and the same fabricated poll, so what differs is unclear; and
    // Api::V1::PollsController#set_poll maps BOTH RecordNotFound and
    // Mastodon::NotPermittedError to 404, so the trigger is the
    // `authorize @poll.status, :show?` policy - which depends on
    // follow/block state, not visibility alone. A poll's own author always
    // passes that policy, which is the only case the bot exercises.
    //
    // Guessing here would make the mock stricter or looser than the server it
    // stands in for, which is the one thing it must not be.
    const created = await post(server, {
      status: "private poll",
      visibility: "private",
      poll: { options: ["a", "b"], expires_in: 300 },
    });
    const pollId = ((created.poll ?? {}) as Json).id as string;
    const res = await fetch(`${server.baseUrl}/api/v1/polls/${pollId}`, { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it("allows the poll's own author to read the poll regardless of visibility", async () => {
    // Api::V1::PollsController#set_poll authorizes @poll.status :show?, and
    // an author always sees their own status. This is the case the bot needs,
    // so it is pinned explicitly rather than left to the ambiguity above.
    const created = await post(server, {
      status: "private poll",
      visibility: "private",
      poll: { options: ["a", "b"], expires_in: 300 },
    });
    const pollId = ((created.poll ?? {}) as Json).id as string;
    const res = await fetch(`${server.baseUrl}/api/v1/polls/${pollId}`, { headers: AUTH });
    expect(res.status).toBe(200);
  });
});

describe("upstream: GET /api/v1/conversations (conversations_spec.rb)", () => {
  let server: MockMastodonServer;
  beforeEach(async () => {
    server = await start();
  });

  it("returns a conversation per direct thread, with one account when nobody is mentioned", async () => {
    // upstream: PostStatusService... 'Hey @alice' and 'Hey, nobody here',
    // then expect(parsed_body.size).to eq 2 and first[:accounts].size == 1
    await post(server, { status: "Hey, nobody here", visibility: "direct" });
    const res = await fetch(`${server.baseUrl}/api/v1/conversations`, { headers: AUTH });
    const body = (await res.json()) as Json[];
    expect(body.length).toBeGreaterThanOrEqual(1);
    expect((body[0]?.accounts as unknown[]).length).toBe(1);
  });

  it("returns pagination headers when limited", async () => {
    // upstream: include_pagination_headers(prev:, next:) with limit: 1
    await post(server, { status: "one", visibility: "direct" });
    await post(server, { status: "two", visibility: "direct" });
    const res = await fetch(`${server.baseUrl}/api/v1/conversations?limit=1`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const link = res.headers.get("Link");
    expect(link).toContain('rel="next"');
    expect(link).toContain('rel="prev"');
  });

  it("returns everything when since_id is older than all conversations", async () => {
    // upstream: since_id 1.hour.ago -> size == 2
    await post(server, { status: "one", visibility: "direct" });
    await post(server, { status: "two", visibility: "direct" });
    const res = await fetch(`${server.baseUrl}/api/v1/conversations?since_id=1`, {
      headers: AUTH,
    });
    expect(((await res.json()) as Json[]).length).toBe(2);
  });

  it("returns nothing when since_id is in the future", async () => {
    // upstream: since_id 1.hour.from_now -> size == 0
    await post(server, { status: "one", visibility: "direct" });
    const res = await fetch(
      `${server.baseUrl}/api/v1/conversations?since_id=9999999999999`,
      { headers: AUTH },
    );
    expect(((await res.json()) as Json[]).length).toBe(0);
  });
});
