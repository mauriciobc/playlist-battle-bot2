import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, migrate, type Db } from "../src/db/index.js";
import { dm } from "../src/mastodon/dm.js";
import type { MastodonClient } from "../src/mastodon/client.js";

describe("dm handle qualification", () => {
  let dir: string;
  let db: Db;
  let posts: { path: string; body: unknown }[];
  let client: MastodonClient;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pb-dm-"));
    db = openDatabase(join(dir, "test.db"));
    migrate(db);
    posts = [];
    client = {
      post: vi.fn(async (path: string, body?: unknown) => {
        posts.push({ path, body });
        return { id: `status-${posts.length}` };
      }),
    } as unknown as MastodonClient;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("qualifies bare local username with instance domain", async () => {
    await dm(db, client, "id-alice", "hi", "alice", {}, "mastodon.social");
    const body = posts[0]!.body as { status: string; visibility: string };
    expect(body.status).toBe("@alice@mastodon.social hi");
    expect(body.visibility).toBe("direct");
  });

  it("leaves already-qualified remote handle unchanged", async () => {
    await dm(db, client, "id-host", "hi", "host@ursal.zone", {}, "mastodon.social");
    const body = posts[0]!.body as { status: string };
    expect(body.status).toBe("@host@ursal.zone hi");
  });

  it("prefers players.acct over fallback and qualifies it", async () => {
    db.prepare(
      `INSERT INTO games (id, status, theme, playlist_length, host_account_id, poll_duration_sec,
        acceptance_deadline, submission_deadline, thread_root_id, current_round, pot, created_at, updated_at,
        creation_status_id, creation_visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "g1", "INVITED", "Theme", 8, "id-host", 3600,
      null, null, null, 0, 0, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z",
      null, "public",
    );
    db.prepare(
      "INSERT INTO players (game_id, account_id, acct, display_name, role, invite_status, points, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("g1", "id-alice", "alice", null, "challenger", "pending", 0, null);
    await dm(db, client, "id-alice", "hello", "ignored@elsewhere.example", {}, "mastodon.social");
    const body = posts[0]!.body as { status: string };
    expect(body.status).toBe("@alice@mastodon.social hello");
  });

  it("leaves numeric accountId untouched when no acct is known", async () => {
    await dm(db, client, "12345", "hi", undefined, {}, "mastodon.social");
    const body = posts[0]!.body as { status: string };
    expect(body.status).toBe("@12345 hi");
  });

  it("does not double-qualify when instanceDomain is omitted", async () => {
    await dm(db, client, "id-alice", "hi", "alice");
    const body = posts[0]!.body as { status: string };
    expect(body.status).toBe("@alice hi");
  });
});
