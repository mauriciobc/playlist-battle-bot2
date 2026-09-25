import { describe, it, expect, beforeEach } from "vitest";
import { MockMastodonServer } from "../test/integration/mock-mastodon.js";
import { AUTH, jsonOf, postJson, type Json } from "../test/integration/mock-kit.js";

/**
 * The bot only ever touches six routes. These tests pin the contract of
 * each one to the real Mastodon implementation, cited per describe block
 * from https://github.com/mastodon/mastodon:
 *
 *   REST::NotificationSerializer      - notification shape
 *   REST::StatusSerializer            - status shape, :poll association
 *   REST::PollSerializer              - poll shape, voted/own_votes
 *   Api::V1::PollsController#show     - include_results: true
 *   Api::V1::Polls::VotesController   - params.require(:choices)
 *   PollExpirationValidator           - MIN_EXPIRATION = 5.minutes
 *   PollOptionsValidator              - MAX_OPTIONS 4, MAX_OPTION_CHARS 50
 *
 * A mock that diverges here proves nothing about the bot. These assertions
 * are what keep it honest.
 */

/**
 * The bot and the player share a username on different instances, so a bare
 * lookup has to pick the local account, not merely any "mauriciobc".
 */
async function start() {
  const server = new MockMastodonServer({
    botAcct: "mauriciobc@mock.social",
    hostAcct: "saiugol@mock.social",
    playerAcct: "mauriciobc@ursal.zone",
  });
  await server.start();
  return server;
}

function url(server: MockMastodonServer, path: string): string {
  return `${server.baseUrl}${path}`;
}

/** Poll body with its options narrowed to what the tests assert on. */
type PollBody = Json & { options: Array<{ title: string; votes_count: number | null }> };
async function pollOf(res: Response): Promise<PollBody> {
  return (await res.json()) as PollBody;
}

describe("MockMastodon: authentication", () => {
  let server: MockMastodonServer;
  beforeEach(async () => {
    server = await start();
  });

  it("rejects a request with no Authorization header", async () => {
    const res = await fetch(url(server, "/api/v1/accounts/verify_credentials"));
    expect(res.status).toBe(401);
  });

  it("returns the bot account from verify_credentials", async () => {
    const res = await fetch(url(server, "/api/v1/accounts/verify_credentials"), {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    // AccountSerializer: id, username, acct are always present.
    expect(body.acct).toBe("mauriciobc@mock.social");
    expect(typeof body.id).toBe("string");
    expect(body.id).not.toBe("");
  });
});

describe("MockMastodon: notifications (REST::NotificationSerializer)", () => {
  let server: MockMastodonServer;
  beforeEach(async () => {
    server = await start();
  });

  it("honours exclude_types and can return an empty page", async () => {
    server.pushNotification({ type: "mention", fromAcct: "saiugol@mock.social" });
    const res = await fetch(
      url(server, "/api/v1/notifications?exclude_types[]=mention"),
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("includes status for mention notifications, as status_type? requires", async () => {
    const id = server.pushNotification({
      type: "mention",
      fromAcct: "saiugol@mock.social",
      statusId: "9001",
    });
    const res = await fetch(url(server, "/api/v1/notifications?limit=10"), {
      headers: AUTH,
    });
    const body = (await res.json()) as Json[];
    const n = body.find((x) => x.id === id);
    if (n === undefined) throw new Error("notification not returned");
    // attributes :id, :type, :created_at, :group_key are unconditional.
    for (const field of ["id", "type", "created_at", "group_key"]) {
      expect(n[field]).toBeDefined();
    }
    // belongs_to :target_status, key: :status, if: :status_type?
    expect(n.status).toBeDefined();
  });

  it("returns newest-first and a Link header when more remain", async () => {
    server.pushNotification({ type: "mention", fromAcct: "saiugol@mock.social" });
    const b = server.pushNotification({ type: "mention", fromAcct: "saiugol@mock.social" });
    const res = await fetch(url(server, "/api/v1/notifications?limit=1"), {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const page = (await res.json()) as Array<{ id: string }>;
    expect(page).toHaveLength(1);
    // Mastodon returns notifications newest-first.
    expect(page[0]?.id).toBe(b);
    // getWithLink() reads the Link header, not the body.
    const link = res.headers.get("Link");
    expect(link).toBeTruthy();
    expect(link).toContain('rel="next"');
    // Api::Pagination#pagination_max_id is `pagination_collection.last.id` -
    // the OLDEST id on the page just served, not the newest. Verified in
    // app/controllers/concerns/api/pagination.rb.
    const maxId = link!.match(/max_id=(\d+)/)?.[1];
    expect(maxId).toBe(b);
  });

  it("honours since_id, so a poll loop does not replay old notifications", async () => {
    const a = server.pushNotification({ type: "mention", fromAcct: "saiugol@mock.social" });
    const b = server.pushNotification({ type: "mention", fromAcct: "saiugol@mock.social" });
    const res = await fetch(
      url(server, `/api/v1/notifications?since_id=${a}`),
      { headers: AUTH },
    );
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((n) => n.id)).toEqual([b]);
  });

  it("pages forward from min_id, oldest first, with a rel=prev link", async () => {
    const a = server.pushNotification({ type: "mention", fromAcct: "saiugol@mock.social" });
    const b = server.pushNotification({ type: "mention", fromAcct: "saiugol@mock.social" });
    const c = server.pushNotification({ type: "mention", fromAcct: "saiugol@mock.social" });

    const res = await fetch(url(server, `/api/v1/notifications?min_id=${a}&limit=1`), { headers: AUTH });
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((n) => n.id)).toEqual([b]);
    const link = res.headers.get("Link");
    expect(link).toContain('rel="prev"');
    expect(link).toContain(`min_id=${b}`);

    const last = await fetch(url(server, `/api/v1/notifications?min_id=${c}`), { headers: AUTH });
    expect(await last.json()).toEqual([]);
    expect(last.headers.get("Link")).toBeNull();
  });
});

describe("MockMastodon: statuses (REST::StatusSerializer)", () => {
  let server: MockMastodonServer;
  beforeEach(async () => {
    server = await start();
  });

  const postStatus = (body: Json) => postJson(server, "/api/v1/statuses", body);

  it("creates a status and serializes the poll association", async () => {
    const res = await postStatus({
      status: "poll time",
      poll: { options: ["left", "right"], expires_in: 300 },
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.id).toBeDefined();
    // has_one :preloadable_poll, key: :poll
    expect(body.poll).toBeDefined();
    const poll = (body.poll ?? {}) as Json;
    // attributes :id, :expires_at, :expired, :multiple, :votes_count, :voters_count
    for (const f of ["id", "expires_at", "expired", "multiple", "votes_count", "voters_count"]) {
      expect(poll[f]).toBeDefined();
    }
    // has_many :loaded_options, key: :options
    expect(Array.isArray(poll.options)).toBe(true);
  });

  it("rejects a poll shorter than MIN_EXPIRATION (5.minutes) with 422", async () => {
    const res = await postStatus({
      status: "too short",
      poll: { options: ["a", "b"], expires_in: 30 },
    });
    // PollExpirationValidator: MIN_EXPIRATION = 5.minutes
    expect(res.status).toBe(422);
    const body = await jsonOf(res);
    expect(body.error).toBeTruthy();
  });

  it("accepts exactly 300 seconds", async () => {
    const res = await postStatus({
      status: "exactly the floor",
      poll: { options: ["a", "b"], expires_in: 300 },
    });
    expect(res.status).toBe(200);
  });

  it("rejects more than MAX_OPTIONS (4) and duplicate options", async () => {
    const five = await postStatus({
      status: "five",
      poll: { options: ["a", "b", "c", "d", "e"], expires_in: 300 },
    });
    expect(five.status).toBe(422);

    const dupes = await postStatus({
      status: "dupes",
      poll: { options: ["a", "a"], expires_in: 300 },
    });
    expect(dupes.status).toBe(422);
  });

  it("deletes a status and 404s an unknown one", async () => {
    const { id } = await jsonOf(await postStatus({ status: "temporary" }));
    const del = await fetch(url(server, `/api/v1/statuses/${id}`), {
      method: "DELETE",
      headers: AUTH,
    });
    expect(del.status).toBe(200);
    const gone = await fetch(url(server, "/api/v1/statuses/does-not-exist"), {
      headers: AUTH,
    });
    expect(gone.status).toBe(404);
  });
});

describe("MockMastodon: polls (REST::PollSerializer + controllers)", () => {
  let server: MockMastodonServer;
  let pollId: string;
  beforeEach(async () => {
    server = await start();
    const res = await postJson(server, "/api/v1/statuses", {
      status: "round 1",
      poll: { options: ["alice", "bob"], expires_in: 300 },
    });
    pollId = String(((await jsonOf(res)).poll as Json).id);
  });

  const vote = (body: Json) => postJson(server, `/api/v1/polls/${pollId}/votes`, body);

  it("serves GET /api/v1/polls/:id with include_results semantics", async () => {
    const res = await fetch(url(server, `/api/v1/polls/${pollId}`), {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.expired).toBe(false);
    expect(body.options).toEqual([
      { title: "alice", votes_count: 0 },
      { title: "bob", votes_count: 0 },
    ]);
  });

  it("accepts a vote via plural choices and tallies it", async () => {
    // Api::V1::Polls::VotesController#vote_params: params.require(:choices)
    const res = await vote({ choices: [0] });
    expect(res.status).toBe(200);
    const body = await pollOf(res);
    expect(body.options[0]?.votes_count).toBe(1);
    expect(body.votes_count).toBe(1);
    expect(body.voters_count).toBe(1);
  });

  it("rejects a vote without choices (params.require(:choices))", async () => {
    // A singular `choice` is not a tolerated alias: params.require(:choices)
    // raises ParameterMissing -> 400, as polls/votes_spec.rb expects.
    const res = await vote({ choice: 0 });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("rejects an out-of-range choice", async () => {
    const res = await vote({ choices: [7] });
    expect(res.status).toBe(422);
  });

  it("serializes voted and own_votes because the request is authenticated", async () => {
    await vote({ choices: [0] });
    const res = await fetch(url(server, `/api/v1/polls/${pollId}`), {
      headers: AUTH,
    });
    const body = await jsonOf(res);
    // attribute :voted / :own_votes, if: :current_user?
    expect(body.voted).toBe(true);
    expect(body.own_votes).toEqual([0]);
  });

  it("marks the poll expired and exposes tallies once expires_at passes", async () => {
    // Vote first, so there is a tally to reveal. Poll#show_totals_now? is
    // `expired? || !hide_totals?` - expiry is what un-hides the counts.
    await vote({ choices: [0] });
    server.expirePoll(pollId);
    const res = await fetch(url(server, `/api/v1/polls/${pollId}`), {
      headers: AUTH,
    });
    const body = await pollOf(res);
    // def expired -> object.expired? ; include_results: true means tallies show
    expect(body.expired).toBe(true);
    expect(body.options[0]?.votes_count).toBe(1);
  });
});

describe("MockMastodon: account lookup", () => {
  let server: MockMastodonServer;
  beforeEach(async () => {
    server = await start();
  });

  it("resolves a fully-qualified handle to its own host", async () => {
    const res = await fetch(
      url(server, "/api/v1/accounts/lookup?acct=saiugol%40mock.social"),
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).acct).toBe("saiugol@mock.social");
  });

  it("resolves a bare handle against the requesting account's instance", async () => {
    // qualifyAcct() in the bot qualifies a bare acct with the viewer's host.
    const res = await fetch(
      url(server, "/api/v1/accounts/lookup?acct=mauriciobc"),
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect((await jsonOf(res)).acct).toBe("mauriciobc@mock.social");
  });

  it("404s an unknown handle", async () => {
    const res = await fetch(
      url(server, "/api/v1/accounts/lookup?acct=nobody%40mock.social"),
      { headers: AUTH },
    );
    expect(res.status).toBe(404);
  });
});
