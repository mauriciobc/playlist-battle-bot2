import { describe, expect, it } from "vitest";
import { dm } from "../src/mastodon/dm.js";
import { seedGame, seedPlayer, useHarness } from "./support.js";

describe("dm addressing", () => {
  const h = useHarness();

  it.each([
    ["leaves a bare local username bare", "mastodon.social", "id-alice", "alice", "@alice hi"],
    ["collapses a handle carrying the instance's own domain", "mastodon.social", "id-alice", "alice@Mastodon.Social", "@alice hi"],
    ["leaves a remote handle unchanged", "mastodon.social", "id-host", "host@ursal.zone", "@host@ursal.zone hi"],
    ["leaves a numeric account id untouched when no acct is known", "mastodon.social", "12345", undefined, "@12345 hi"],
    ["works without a configured instance domain", undefined, "id-alice", "alice", "@alice hi"],
  ])("%s", async (_, instanceDomain, accountId, fallbackAcct, expected) => {
    await dm({ db: h.db, client: h.deps.client, ...(instanceDomain ? { instanceDomain } : {}) }, accountId, "hi", fallbackAcct);

    expect(h.posts.map((p) => p.body)).toEqual([{ status: expected, visibility: "direct" }]);
  });

  it("prefers the stored players.acct over the fallback", async () => {
    seedPlayer(h.db, seedGame(h.db), "id-alice", { acct: "alice" });

    await dm({ db: h.db, client: h.deps.client, instanceDomain: "mastodon.social" }, "id-alice", "hello", "ignored@elsewhere.example");

    expect(h.posts[0]!.body.status).toBe("@alice hello");
  });
});
