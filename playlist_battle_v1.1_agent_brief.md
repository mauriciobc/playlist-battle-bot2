# Playlist Battle — v1.1 Rule Changes: Agent Implementation Brief

**Repo:** Playlist Battle Mastodon bot (TypeScript, Node 22+, better-sqlite3, pure state machine in `src/game/`)
**Sources of truth:** `README.md`, `RULES.md`, PRD v1.0 (`playlist_battle_prd.md`)
**Goal:** Land the v1.1 rule patch — code-affecting changes + doc updates, with tests.
**Non-negotiable:** Do NOT implement normalized/scaled scoring, pot scaling, round multipliers, cross-game jackpots, or compact mode. Those were evaluated and rejected. Scope creep will be reverted.

---

## 0. Process for the agent

1. Read `RULES.md`, `README.md`, `src/game/` (state machine + scoring), `src/scheduler/`, `src/handlers/`, `tests/` first. Produce a plan listing every file you will touch and why, before editing.
2. Make the smallest change that satisfies each item. Prefer deleting branches over adding flags.
3. Docs and tests change in the same commit/PR as the code they describe.
4. Verify: `npm run test`, `npm run typecheck`, `npm run lint`, and `npm run e2e:console` must pass. Add unit tests for every new rule branch and extend the scripted e2e vectors where feasible.
5. Do not add env vars, DB migrations, or dependencies unless an item below explicitly requires it.

---

## 1. Code-affecting rule changes

### 1.1 Full-commitment playlists (removes the partial-playlist incentive hole)

**Current:** a player with `m < N` valid tunes auto-forfeits rounds `m+1…N` and stays in the duel.
**New:** a playlist is valid only if complete. At the submission deadline, a player with fewer than N valid tunes is treated exactly as a non-submitter (withdrawal). The duel starts only among players with complete playlists; the existing outcomes apply (2+ complete → duel; exactly 1 → default win; 0 → FIZZLED).

- `src/game/`: remove the partial-playlist / round-forfeiture branch. A playlist is either `complete` or `withdrawn`.
- `src/scheduler/`: submission sweep marks incomplete players as withdrawn instead of recording `m`.
- Keep walkover logic in round resolution — it still serves item 1.4 (dead-video round forfeits).
- **Legacy games:** on resume, any in-flight COLLECTING game with a recorded partial playlist must be reconciled under the new rule (withdraw the player). Add a one-line note in RULES.md that upgrading mid-game applies new rules on resume.
- Docs: rewrite the "Incomplete playlist" rows in README and RULES.md.

**Acceptance:** no code path can produce a player eligible for some rounds but not others, except via item 1.4. Unit test: 7/8-valid playlist at deadline → withdrawal; 8/8 → READY.

### 1.2 Round quorum

**New rule:** a round whose poll receives fewer than 3 total votes is scored as a tie (pot +1), even if one option leads 1–0 or 2–0.

- Implement in round resolution only; the poll still runs and displays normally.
- Docs: add "Quorum" row to the rules tables (README + RULES.md).

**Acceptance:** scripted unit vectors: 1–0 → tie, pot+1; 3-vote round with a leader → strict win; 0 votes → tie (existing behavior preserved).

### 1.3 Final-round pot split (replaces "void")

**New rule:** if the final round ties, the pot is divided equally among the final round's tied players (integer division; remainder is discarded — document it).

- Change the finale scoring branch. Update README, RULES.md, and the PRD if present in repo.

**Acceptance:** unit test: pot=3, final round 2-way tie → +1 point each, pot 0; finale summary reflects the bonus.

### 1.4 Unavailable-video policy

**New rule:** if a player's tune for round k is unavailable (oEmbed no longer resolves / non-200) when the bot prepares the round, the bot DMs the player offering a replacement until the round post is published. If no valid replacement arrives in time, the player forfeits that round only (excluded from the poll; remaining players duel; single remaining player = walkover, takes the pot).

- Add a pre-round availability check in `src/scheduler/` (reuses the oEmbed cache in `src/youtube/`; negative results must NOT be served from cache).
- Replacement window = the interval between the previous round's resolution and this round's publish, minimum a few minutes (constant in config.ts, e.g. `REPLACEMENT_GRACE_MIN=15` — this is the one new config key allowed).
- If the player is unreachable (deleted/block) during replacement → fall through to item 1.5 precedence.
- Docs: new "Unavailable videos" section in RULES.md.

**Acceptance:** unit tests for: replace succeeds; replace never arrives → round forfeit; 2 of 3 players left → poll runs with 2 options; 1 left → walkover.

### 1.5 Deletion precedence over walkover

**New rule:** a deleted/unreachable player account always causes FORFEIT (no champion), even if the deletion would leave exactly one eligible player. Walkovers may only result from round-level forfeits (item 1.4), never from player disappearance.

- Reconcile the lifecycle precedence in `src/game/`: the FORFEIT transition outranks walkover evaluation at every stage.
- Docs: replace the ambiguous rows in RULES.md with one explicit precedence sentence.

**Acceptance:** unit test: 2-player game, round 3, one account deleted → FORFEIT, no finale, no champion.

### 1.6 Edit-until-deadline

**New rule (make explicit, likely already true):** a player may re-submit freely before the deadline; the last complete valid playlist locks at the deadline. Verify the handler currently accepts re-submissions and document the behavior; if it silently rejects duplicates-after-first, fix it.

**Acceptance:** unit test: two submissions, second one wins; submission after deadline rejected.

### 1.7 Shuffled poll option order

**New rule:** poll options are shuffled per round, deterministic — seed = hash(gameId + roundNumber). No player is always first; the host has no fixed slot.

- Implement in the round-publish path; round announce and tune posts keep player-labeled attribution (order there is irrelevant, but keep it consistent with the poll for readability).
- Docs: one line in RULES.md.

**Acceptance:** unit test: same game, rounds 1..3 produce different option orders; order is reproducible for a fixed seed.

---

## 2. Doc-only changes (no logic)

| # | Change | Files |
|---|---|---|
| 2.1 | State explicitly: "players may vote, including for their own tunes" | README rules table, RULES.md |
| 2.2 | Round announce template gains a judging prompt: default "Vote for the song that best fits the theme: \"{theme}\"" (template string change in the round publisher — trivial code, listed here because it's player-facing copy) | `src/` post templates, RULES.md |
| 2.3 | Cancellation semantics: cancellation voids the game — no champion, no pot; scores are historical record only | RULES.md lifecycle table |
| 2.4 | Fix worst-case game length: `acceptance + submission + (N x poll duration) + scheduling overhead`; keep the auto-delete warning keyed to this formula | README |
| 2.5 | Replace "song-vs-song" wording with "round showdown" everywhere | README, RULES.md |

---

## 3. Explicit non-goals (do not implement)

- Normalized vote-share scoring / fixed-points-per-round
- Pot scaling with turnout
- Late-round score multipliers
- Persistent cross-game jackpot
- Compact vs. showcase round display modes
- Stat-rich finale (round wins / runner-up finishes) — v1.2 candidate

---

## 4. Definition of done

- [ ] All items 1.1–1.7 implemented with unit tests; e2e vectors updated where they touch changed branches
- [ ] `npm run test`, `typecheck`, `lint`, `e2e:console` green (including `--random` fuzz run, fixed seed for reproducibility)
- [ ] README + RULES.md consistent with code; PRD section numbers referenced in RULES.md still resolve
- [ ] No new dependencies; only new config key is `REPLACEMENT_GRACE_MIN`
- [ ] Resume-after-restart live check still passes (step 6 of the live test procedure) with an in-flight game spanning the upgrade
