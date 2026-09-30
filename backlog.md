# Backlog

## Achievements + leaderboard

Design notes for a merit system on the duel bot. Nothing here is implemented.

### Premise

Two ideas were on the table: a leaderboard posted to the bot's main feed on a
cadence, and merit badges per account. Design constraints that shaped the
result, and why:

- **This is a personal account** (`BOT_ACCT=@mauriciobc` on mastodon.social).
  Unsolicited posts to the whole follower list are a bad trade — the
  reputational cost lands on a human, not a mascot. The leaderboard therefore
  posts *into a game thread*, and is otherwise pull-based.
- **The goal is people enjoying themselves and competition continuing.** Not
  funnel metrics. That rules out: near-miss nudge lines ("@bob is 2 wins from
  X" — a compulsion device, wrong tone here), streak badges that reset on
  absence, and all-time ladders that a high-volume player owns permanently.
- **Voter engagement is not measurable.** Mastodon's poll API returns only
  `options[].votes_count`; there is no voter-identity endpoint, and
  `tallyPoll` reflects that. Every metric here lives on the supply side
  (players), not the demand side (voters). Do not design voter badges.

### Blocking caveat

`data/bot.db` currently holds **one** game, `EXPIRED`, with 0 tunes and 0
rounds. The outbox points at `https://localhost:8443` (the mock) and only the
`recovery` loop has a heartbeat, so this is an e2e run, not live state — but it
means there is no real volume to rank yet. Ship the merit engine; expect the
leaderboard to self-suppress via the anti-void rule until games actually close.

### Schema (migration 17)

Record outcomes at the finale rather than re-deriving later. `champions()` in
`scoring.ts` runs over `duelParticipants`, which filters on round records to
exclude withdrawn players; a withdrawn player sits at 0 points and is never
crowned (RULES §4). Re-deriving from points alone would crown everyone in an
all-zero finale (quorum-tie chain, pot zeroed). Streaks also need a stable
ordering, and `updated_at` is touched by every `saveGame`.

```sql
ALTER TABLE games ADD COLUMN closed_at TEXT;

CREATE TABLE game_results (
  game_id TEXT PRIMARY KEY REFERENCES games(id),
  theme TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  champion_count INTEGER NOT NULL,   -- 1 decided, >1 shared
  champions_json TEXT NOT NULL
);

CREATE TABLE game_participants (
  game_id TEXT NOT NULL REFERENCES games(id),
  account_id TEXT NOT NULL,
  acct TEXT NOT NULL,
  role TEXT NOT NULL,
  points INTEGER NOT NULL,
  was_champion INTEGER NOT NULL,
  PRIMARY KEY (game_id, account_id)
);
CREATE INDEX idx_participants_account ON game_participants(account_id);

CREATE TABLE badges (
  account_id TEXT NOT NULL,
  badge TEXT NOT NULL,
  awarded_at TEXT NOT NULL,
  game_id TEXT,
  PRIMARY KEY (account_id, badge)
);
CREATE INDEX idx_badges_awarded ON badges(awarded_at);
```

`badges` is keyed `(account_id, badge)` so each badge is awarded **once ever**.
Tiered badges are distinct ids — `plays_5`, `plays_25` — not one row with a
counter. That is what makes a 5-win run permanent: taking a week off costs
nothing.

### Which games count

| Status | Counts as | Why |
| --- | --- | --- |
| `CLOSED` | full | real duel, champion exists |
| `CANCELLED` | participation only | RULES: scores are historical record only; no champion, so no win |
| `EXPIRED` | nothing | no duel happened |
| `FIZZLED` | nothing | no complete playlist was ever submitted |
| `FORFEIT` | nothing | void |

Round wins come from `rounds WHERE status = 'resolved'` only. `walkover` and
`auto_tied` also set `winner_account_id`, and winning because an opponent
forfeited is not merit.

### Badges

Participation — everyone who shows up earns something:
`debut` · `plays_5` · `plays_25` · `completionist` (full 12-track playlist) ·
`marathon` (played through the last round)

Skill:
`first_blood` · `hat_trick` (3 consecutive wins) · `on_a_run` (5) ·
`unstoppable` (10)

Federation — differentiated, and they grow the player pool:
`first_contact` (beat someone off-instance; `acct` contains `@`) ·
`wanderer` (played across 3 instances) · `durable` (10 duels, 10 different
opponents)

Hosting — feeds the funnel:
`conductor` (first duel hosted) · `promoter` (10 hosted)

Thirteen is a ceiling, not a quota. `completionist` and `marathon` are close to
automatic for anyone who plays a 12-round duel and read as filler next to
`hat_trick`; cut those two first if the ladder looks padded in rendered copy.

### Delivery: two channels

A DM has no network effect, so it is a supplement and never the only channel.

**Public — a reply to the finale summary**, `pb:v1:finale:<id>:badges`. Not
inside the summary: `postFinale` already spends its 500-char budget on
champion + theme + standings + pot split + duel link. One post listing who
earned what, up to four mentions — four separate posts would be four
notifications, and this is one while still pinging each player, which is the
amplification that makes the feature worth building.

```
🏅 Novas conquistas
• @alice: 🎩 Hat-trick · 🌐 First Contact
• @bob: 🎖️ Debut
```

**DM** carries the detail: full badge list, career line, position.

### Progress

Done: migration 17, `src/game/merit.ts`, `src/db/merit.ts`, the finale wiring
(results + participants + badge award in one transaction, status flip last),
`postBadges`, and the i18n copy in both catalogs. 575 unit tests and 117 e2e
checks pass. Verified end to end — a losing dueler still earns participation
badges, a winner earns skill and hosting ones:

```
🏅 Achievements unlocked
• @host: 📀 Full Playlist · 🎪 Conductor · 🎖️ Debut · 🩸 First Blood · 🏃 Marathon
• @alice: 📀 Full Playlist · 🎖️ Debut
```

Not done: the badge DM, the `ranking` command (public + DM), the weekly
leaderboard sweep, and the RULES.md section.

One thing the e2e output settled: `completionist` and `marathon` fire for
everybody, because any completed duel satisfies both. They read as noise next
to `first_blood`. Cut them first if the ladder looks padded.

### Crash safety

Falls out of the existing structure. Results and badge awards are written in
one transaction before the `FINALE → CLOSED` status flip in
`emitClaimedFinale`; the announcement is posted after, keyed idempotently.
Recovery re-enters `emitClaimedFinale`, the `badges` primary key makes the
award a no-op, and the same idempotency key makes the post safe to repeat.

### Leaderboard

- **Cadence:** weekly, ISO week, Monday
- **Placement:** reply to the most recent game's thread — reaches people already
  following the game, not the whole follower list
- **Window:** rolling 30 days. All-time hands the top spot to whoever played
  most last month and it never moves, which ends the competition. 30 days keeps
  the board turn over so a newcomer can legitimately top it.
- **Boards:** Champions (wins) and Participation (duels played). Two only —
  a third does not fit 500 chars, and Participation is the one that keeps a
  4th-place player in the game.
- **Anti-void:** skip if fewer than 2 duels closed or fewer than 3 distinct
  players in the period. A board over an empty week is worse than silence.
- **Idempotency:** `pb:v1:leaderboard:<iso-week>`
- **Loop:** piggyback on `recovery` (300s). A weekly post does not justify a
  fifth `LOOP_LABELS` entry, and leaving that list alone keeps `healthcheck.ts`
  correct for free.
- **Pull path:** `@bot ranking` public, `ranking` by DM. Pull-based, so it
  carries none of the unsolicited-post risk.

### Files

- `src/game/merit.ts` — pure predicates, streak walk, board ranking, badge-line
  composition. Zero I/O, per the RULES.md convention for the domain layer.
- `src/db/merit.ts` — queries and the three tables
- `src/mastodon/posts.ts` — `postBadges`, `postLeaderboard`
- `src/handlers/commands.ts` — `parseRankingCommand`, mirroring
  `parseStatusCommand`
- `src/handlers/publicCommand.ts` — `handleRanking`, next to `handleStatus`
- `src/handlers/directMessage.ts` — `ranking` branch in the DM switch
- `src/scheduler/merit.ts` — the weekly sweep
- `src/i18n/index.ts` — every string in **both** catalogs. `Messages = typeof en`
  means pt-BR will not compile until it matches, and `LOCALE=pt-BR` is the live
  locale, so the Portuguese is the copy that actually ships. Terms to get right:
  *conquista* vs *emblema* for badge, *desafiante* for challenger, and the
  existing `pts` convention for points.
- `RULES.md` — new section: which statuses count, badge list, streak semantics

### Order of work

1. Migration 17 + `src/game/merit.ts` + tests. Everything else depends on it,
   and the posting layer cannot be verified before it exists.
2. Wire the finale transaction: results, participants, badge awards.
3. `postBadges` in the finale thread + the badge DM.
4. `ranking` command, public and DM.
5. Weekly leaderboard sweep.

### Known wrinkles

`first_contact` and `wanderer` test `acct` for `@`. That is the domain at invite
time and it does not change if someone later migrates instances, so it measures
where you *met* them. Acceptable for a merit badge; worth knowing.

`AUTO_DELETE_WINDOW_HOURS=0` means instance-side auto-delete is not configured.
A leaderboard pointing at old game threads may eventually link to deleted posts.
Worth setting before the leaderboard ships.

---

## Game pacing

Raised while designing the above, not yet scoped. Notes for later.

An 8-round duel at current settings (`ACCEPTANCE_WINDOW_SEC=86400`,
`SUBMISSION_WINDOW_SEC=172800`, `POLL_DURATION_SEC=86400`) runs ~11 days; a
12-round duel ~15. That is a season, not a game, and it breaks the merit system
above — streaks and any badge ladder assume the game is remembered.

The poll ceiling is not really the problem: `EARLY_CLOSE_ENABLED=1` closes a
poll ~5 min after votes stop moving. The problem is one person voting at hour
20, which keeps the poll open for another day. Repeated across 8 rounds, the
duel pays the tail instead of the median. The windows are sized for tardiness,
and tardiness is unbounded.

- `playlist_length` currently sets both the submission burden (8–12 links) and
  the round count. Decoupling them — submit 10–12 tracks, play a sample of ~4
  rounds — cuts tail exposure ~3× without touching curation effort.
  `rounds_played` becomes a tuning knob. Needs a `CHECK` constraint change and a
  RULES.md rewrite.
- `ROUND_QUORUM=3` fights short polls. A duel that cannot reach 3 votes resolves
  as a chain of ties ending in a pot split. Decide the quorum policy before
  shortening polls, or fast games end unwon.
- Do **not** simply cut the acceptance window to 2h. On mastodon.social
  notification delivery is slow and buried; a 2h window likely expires before
  the DM is surfaced, converting a slow game into a reliably dead one. The
  channel is the problem, not the clock. Cheaper fixes first: re-ping the
  challenger once mid-window (the machinery already exists — `invite_sent_at`),
  and allow accepting by public reply in the thread. The real fix is not gating
  on acceptance at all, which is a state-machine change.

The one recorded game shows the shape of this: acceptance deadline
`09-23T01:53:44Z`, transition to `EXPIRED` at `09-23T19:58:47Z` — 18 hours past
deadline, with a 24h window and one silent challenger.
