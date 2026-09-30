import { describe, expect, it, vi } from "vitest";
import type { MastodonClient } from "../src/mastodon/client.js";
import {
  canonicalAcct,
  instanceDomainOf,
  mention,
  qualifyMentions,
  resolveLocalDomain,
  sameAccount,
} from "../src/mastodon/handle.js";

const HOME = "mastodon.social";

describe("mention", () => {
  it.each<[string, string, string | undefined, string]>([
    ["a bare local username stays bare", "alice", HOME, "@alice"],
    ["an own-instance handle collapses to bare", "alice@mastodon.social", HOME, "@alice"],
    ["the own-instance comparison ignores case", "alice@Mastodon.Social", HOME, "@alice"],
    ["a remote handle keeps its domain", "jacky@other.social", HOME, "@jacky@other.social"],
    ["a leading @ is not doubled", "@jacky@other.social", HOME, "@jacky@other.social"],
    ["without an instance a written domain is kept", "alice@mastodon.social", undefined, "@alice@mastodon.social"],
    ["a numeric account id is not treated as a handle", "12345", HOME, "@12345"],
  ])("%s", (_case, acct, domain, expected) => {
    expect(mention(acct, domain)).toBe(expected);
  });
});

describe("canonicalAcct / sameAccount", () => {
  it("collapses the own instance and lower-cases only the domain", () => {
    expect(canonicalAcct("Bob@Mastodon.Social", HOME)).toBe("Bob");
    expect(canonicalAcct("Jacky@Other.Social", HOME)).toBe("Jacky@other.social");
  });

  it("treats usernames as case-insensitive and instances as significant", () => {
    expect(sameAccount("Bob", "bob@mastodon.social", HOME)).toBe(true);
    expect(sameAccount("bob", "bob@other.social", HOME)).toBe(false);
  });
});

describe("qualifyMentions", () => {
  const mentions = [
    { username: "bob", acct: "bob" },
    { username: "jacky", acct: "jacky@other.social" },
  ];

  it("restores the domain the rendered text dropped", () => {
    expect(qualifyMentions("@bob and @jacky", mentions, HOME)).toBe("@bob and @jacky@other.social");
  });

  it("follows the array's order for accounts that share a username", () => {
    const sams = [{ username: "sam", acct: "sam" }, { username: "sam", acct: "sam@other.social" }];
    expect(qualifyMentions("@sam @sam", sams, HOME)).toBe("@sam @sam@other.social");
  });

  it("prefers the entry matching a domain the author did type", () => {
    const sams = [{ username: "sam", acct: "sam" }, { username: "sam", acct: "sam@other.social" }];
    expect(qualifyMentions("@sam@other.social", sams, HOME)).toBe("@sam@other.social");
  });

  it("does not read the domain part of user@host as a mention", () => {
    expect(qualifyMentions("bob@jacky.org", [{ username: "jacky", acct: "jacky@other.social" }], HOME)).toBe(
      "bob@jacky.org",
    );
  });

  it("leaves unlisted mentions as written", () => {
    expect(qualifyMentions("@ghost", mentions, HOME)).toBe("@ghost");
  });
});

describe("local domain", () => {
  const clientWith = (get: () => Promise<unknown>) =>
    ({ baseUrl: "https://web.example.com", localDomain: null, get: vi.fn(get) }) as unknown as MastodonClient;

  it("is the domain the instance reports, not the host the API is served from", async () => {
    const client = clientWith(async () => ({ domain: "Example.COM" }));

    expect(await resolveLocalDomain(client)).toBe("example.com");
    // A remote-looking handle on the account domain is a local account.
    expect(mention("alice@example.com", instanceDomainOf(client))).toBe("@alice");
  });

  it("falls back to the API host when the instance cannot say", async () => {
    const client = clientWith(async () => {
      throw new Error("404");
    });

    expect(await resolveLocalDomain(client)).toBe("web.example.com");
    expect(instanceDomainOf(client)).toBe("web.example.com");
  });

  it("guesses the API host until it has been resolved", () => {
    expect(instanceDomainOf(clientWith(async () => ({})))).toBe("web.example.com");
  });
});
