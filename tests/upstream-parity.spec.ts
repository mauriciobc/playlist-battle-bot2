import { describe, it, expect, beforeEach } from "vitest";
import type { MockMastodonServer } from "../test/integration/mock-mastodon.js";
import { AUTH, jsonOf, post, postJson, startMock, type Json } from "../test/integration/mock-kit.js";

/**
 * These cases are transcribed from Mastodon's own request specs, not from my
 * reading of the serializers. The specs are the authority on behaviour, and
 * mirroring them is what keeps the mock honest:
 *
 *   spec/requests/api/v1/polls/votes_spec.rb
 *     - creates a vote; choices: %w(1)  <- a STRING, not an integer
 *     - cached_tallies becomes [0, 1]
 *   spec/requests/api/v1/polls_spec.rb
 *     - 200 with id, voted, voters_count, votes_count
 *   spec/requests/api/v1/conversations_spec.rb
 *     - returns pagination headers
 *     - 2 conversations, and accounts.size == 1 when the DM mentions nobody
 *     - since_id older than everything -> everything
 *     - since_id in the future -> none
 *
 * Every assertion below names the upstream spec it came from.
 */

const pollIdOf = (created: Json) => ((created.poll ?? {}) as Json).id as string;

describe("upstream: POST /api/v1/polls/:poll_id/votes (polls/votes_spec.rb)", () => {
  let server: MockMastodonServer;
  beforeEach(async () => {
    server = await startMock();
  });

  it("creates a vote with choices as strings, and tallies it", async () => {
    // upstream: let(:params) { { choices: %w(1) } }
    const created = await post(server, {
      status: "poll",
      poll: { options: ["a", "b"], expires_in: 300 },
    });
    const res = await postJson(server, `/api/v1/polls/${pollIdOf(created)}/votes`, {
      choices: ["1"],
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
});

describe("upstream: GET /api/v1/polls/:id (polls_spec.rb)", () => {
  let server: MockMastodonServer;
  beforeEach(async () => {
    server = await startMock();
  });

  it("returns poll data with id, voted, voters_count and votes_count", async () => {
    // upstream: expect(response.parsed_body).to match a hash_including(...)
    const pollId = pollIdOf(
      await post(server, {
        status: "poll",
        poll: { options: ["a", "b"], expires_in: 300 },
      }),
    );
    const res = await fetch(`${server.baseUrl}/api/v1/polls/${pollId}`, { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await jsonOf(res);
    expect(body.id).toBe(pollId);
    expect(body.voted).toBe(false);
    expect(body.voters_count).toBe(0);
    expect(body.votes_count).toBe(0);
  });

  it("allows the poll's own author to read the poll regardless of visibility", async () => {
    // Api::V1::PollsController#set_poll authorizes @poll.status :show?, and
    // an author always sees their own status. This is the case the bot needs.
    //
    // polls_spec's "parent status private -> 404" is deliberately NOT
    // mirrored: set_poll maps both RecordNotFound and NotPermittedError to
    // 404, so the trigger is the `show?` policy - follow/block state, not
    // visibility alone. Guessing would make the mock stricter or looser than
    // the server it stands in for.
    const created = await post(server, {
      status: "private poll",
      visibility: "private",
      poll: { options: ["a", "b"], expires_in: 300 },
    });
    const res = await fetch(`${server.baseUrl}/api/v1/polls/${pollIdOf(created)}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
  });
});

describe("upstream: GET /api/v1/conversations (conversations_spec.rb)", () => {
  let server: MockMastodonServer;
  beforeEach(async () => {
    server = await startMock();
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
