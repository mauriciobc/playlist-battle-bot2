import { describe, expect, it } from "vitest";
import { dm } from "../src/mastodon/dm.js";
import { seedGame, seedPlayer, useHarness } from "./support.js";

describe("dm handle qualification", () => {
  const h = useHarness();

  it.each([
    ["qualifies a bare local username with the instance domain", "mastodon.social", "id-alice", "alice", "@alice@mastodon.social hi"],
    ["leaves an already-qualified remote handle unchanged", "mastodon.social", "id-host", "host@ursal.zone", "@host@ursal.zone hi"],
    ["leaves a numeric account id untouched when no acct is known", "mastodon.social", "12345", undefined, "@12345 hi"],
    ["does not qualify when no instance domain is configured", undefined, "id-alice", "alice", "@alice hi"],
  ])("%s", async (_, instanceDomain, accountId, fallbackAcct, expected) => {
    await dm({ db: h.db, client: h.deps.client, ...(instanceDomain ? { instanceDomain } : {}) }, accountId, "hi", fallbackAcct);

    expect(h.posts.map((p) => p.body)).toEqual([{ status: expected, visibility: "direct" }]);
  });

  it("prefers the stored players.acct over the fallback, and qualifies it", async () => {
    seedPlayer(h.db, seedGame(h.db), "id-alice", { acct: "alice" });

    await dm({ db: h.db, client: h.deps.client, instanceDomain: "mastodon.social" }, "id-alice", "hello", "ignored@elsewhere.example");

    expect(h.posts[0]!.body.status).toBe("@alice@mastodon.social hello");
  });
});
