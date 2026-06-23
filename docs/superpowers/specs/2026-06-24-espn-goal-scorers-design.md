# Design — Automatic goal scorers via ESPN (BDS Pronostico)

**Date:** 2026-06-24
**App:** BDS Pronostico (`World Cup Tiktoks/bdspronostico`) — single-page `FINAL/index.html` + Supabase (Postgres, edge functions, pg_cron).

## Goal

When a World Cup match is being played and after it ends, automatically pull the **goal scorers** and write them onto the match (`matches.scorer_result`) so that 🔥 Buteur bets settle by themselves — the same way scores are already pulled automatically. Today scorers are entered by hand in the admin panel.

## Background — how the app works today

- **Data source for scores:** API-Football (`v3.football.api-sports.io`, league 1 / season 2026), via the `sync-scores` edge function (frontend-triggered every 5 min while the app is open). It writes `matches.score_home`, `score_away`, `status`.
- **Fixture import & knockout bracket:** `import-fixtures` edge function maps DB matches to API-Football fixtures by date + team name (using a `FR_TO_EN` country-name map). This is what makes knockout matches appear on the app once teams are known. **Unchanged by this work.**
- **`protect_finished_matches` trigger:** for `service_role` writes, freezes `status`/`score_home`/`score_away` once a match is `finished` (so auto-sync can't reopen or overwrite an admin-finalised score). Does **not** touch `scorer_result`.
- **Actual results on `matches`:** `score_home`, `score_away`, `status`, `motm_result` (manual), `scorer_result` (manual), `penalty_winner` (manual), plus `api_fixture_id`, `reminder_notified_at`, `scores_notified_at`.
- **`scorer_result` format:** comma-joined list of scorer names, **one entry per goal** (a player who scored twice appears twice), or the literal `'AUCUN_BUT'` when nobody scored. Set today by `saveAdminScorer` (`index.html:7665`).
- **Settlement** (`matchPointsForPlayer`, `index.html:7732-7736`): splits `scorer_result` on commas, lowercases/trims, and checks whether a player's `scorer_bets.pick_player_name` is in the list → awards points by `pick_position` (GK 30, DEF 10, MID 5, ATT 2). `pick_player_name === 'AUCUN_BUT'` matching `scorer_result === 'AUCUN_BUT'` → 6 pts.
- **Critical constraint:** `scorer_result` must contain the **canonical squad names** (`squads.player_name`, keyed by `team_name`), because that is exactly what `scorer_bets.pick_player_name` holds. Names from any external API must be mapped to the squad roster.
- **Push:** `send-push` edge function. Targeted mode: `POST { title, notifications: [{ player_id, body, title? }, ...] }`, looks up `push_subscriptions(player_id, subscription)` and sends web-push. Admins are `players.is_admin = true`.
- **Scheduling precedent:** `match-reminders` runs every 10 min via **pg_cron + pg_net** (`schedule_match_reminders.sql`) hitting the function URL with the anon bearer token. Same mechanism is reused here.

## Why ESPN, not API-Football, for scorers

- API-Football's free plan is unreliable for the `/fixtures/events` (scorer) endpoint and would also blow its ~100 requests/day free quota if polled every few minutes server-side.
- ESPN's public `site.api` is free, keyless, CDN-backed, **already used by the recap generators** (`World Cup Tiktoks/gen-2026-06-22.js:89-110`), and exposes scorers, score, and status — updated **live** during the match (each goal appears within ~1-2 min).

API-Football stays for fixture import / knockout population. ESPN drives the live in-match score + scorers loop.

## Architecture

### 1. New column

```sql
alter table matches add column if not exists espn_event_id text;
```
Caches the resolved ESPN event id per match so we resolve it only once.

### 2. New edge function: `sync-espn-live`

Runs per invocation (no body needed):

1. **Select candidate matches** from the DB: `kickoff` is in the past **and** within the last ~3h (covers 90 min + extra time + penalties + buffer), and `status != 'finished'` OR `scorer_result IS NULL`. (Use the existing day/kickoff fields; reuse `parseDay`-style logic already in `import-fixtures` to derive a timestamp.) If none → return early (cheap; this is the common case).
2. **Resolve ESPN event id** for any candidate missing `espn_event_id`:
   - `GET https://site.api.espn.com/apis/site/v2/sports/soccer/FIFA.WORLD/scoreboard?dates=YYYYMMDD` for the match's kickoff date.
   - Match an event by comparing ESPN's English team names to the match's French `home`/`away` via the existing `FR_TO_EN` map (normalize accents/case; allow `includes` both ways, as `import-fixtures` does).
   - On success, store `espn_event_id`. On failure, skip this match this run (it will retry next poll) and include it in the unmatched log.
3. **Fetch the summary** for each resolved match:
   - `GET .../FIFA.WORLD/summary?event={espn_event_id}`.
   - **Live score + status** from the header competition (`competitors[].score`, `status.type`): map ESPN status → `live` / `finished` / leave as-is.
   - **Goals** from `competitions[0].details[]`: keep entries with `scoringPlay === true`; exclude own goals (`ownGoal === true`) and penalty-shootout goals (shootout entries are distinguishable by period/clock — exclude anything after regulation+ET that belongs to the shootout). Capture `participants[0].athlete.shortName`, `team.id` (→ home/away), and minute (`clock.displayValue`, cleaned).
4. **Map each scorer name → squad name** (see "Name mapping" below).
5. **Write to `matches`:**
   - `score_home`, `score_away`, `status` — live updates. The `protect_finished_matches` trigger still guards a match already `finished`.
   - `scorer_result` — **only if currently NULL/empty** (never overwrite a manual correction): canonical names joined by `, ` in minute order, one per goal; or `'AUCUN_BUT'` if the match is finished with zero qualifying goals.
6. **Admin alert on unmatched scorers:** if a goal's scorer cannot be confidently mapped to a squad name, still record the goal using the raw ESPN name (keeps the score/count correct), and `POST` to `send-push` targeted mode to every `players.is_admin = true` player: e.g. `⚠️ Buteur non reconnu : "X" — {home} vs {away}. À corriger dans l'admin.`

### 3. Schedule (pg_cron + pg_net)

New cron job mirroring `schedule_match_reminders.sql`, every 2 minutes inside the match window only:

```
*/2 16-23,0-7 * * *    -- every 2 min, 16:00–07:59 UTC = 18:00–09:59 CEST
```

Window rationale (researched against the WC 2026 schedule): earliest kick-off 18:00 CEST (16:00 UTC); latest kick-off ~05:00 CEST; a 6am-CEST knockout can run with extra time + penalties to ~08:45 CEST, plus ESPN final-status lag → tail to 10:00 CEST (08:00 UTC). Outside the window the job does not run at all; inside it, runs with no live match return immediately.

## Name mapping (the main risk area)

Two mapping layers, both normalized (lowercase, strip accents/diacritics), both with safe fallback:

1. **Match → ESPN event:** team-name comparison via `FR_TO_EN`. Fallback: skip + retry next poll; logged.
2. **ESPN scorer `shortName` → `squads.player_name`:** for the goal's team only (home or away squad). Strategy, in order:
   - exact normalized equality;
   - surname match (compare the last token of each name);
   - `includes` either direction.
   If still ambiguous/none → use the raw ESPN name in `scorer_result` and fire the admin push alert.

Because auto-fill only happens when `scorer_result` is empty, any admin correction afterward is permanent.

## Edge cases

- **Own goals:** excluded from `scorer_result` (don't credit the player; they help no scorer bet and would distort the top-scorers list).
- **Penalties in open play:** count as goals. **Penalty shootout:** excluded.
- **Same player multiple goals:** name repeated once per goal.
- **No goals, match finished:** `scorer_result = 'AUCUN_BUT'`.
- **Match not yet finished:** may set live score/scorers, but do not write `'AUCUN_BUT'` (a 0-0 in progress is not final).
- **MOTM:** ESPN has no reliable man-of-the-match → `motm_result` stays manual. Out of scope.

## Out of scope

- Changing `import-fixtures` / knockout population (stays on API-Football).
- Automating MOTM or penalty-shootout winner.
- Migrating the existing API-Football `sync-scores` away (it can remain as a redundant score path; this design does not require removing it).

## Testing

- Unit-test the pure helpers: name normalization, surname match, ESPN-summary → goal-list parser (own goal / shootout exclusion), `scorer_result` builder (ordering, repeats, `AUCUN_BUT`).
- Manual: point at a finished WC fixture's ESPN event, confirm `scorer_result` equals the hand-entered value; confirm an intentionally-unmatchable name triggers the admin push and leaves the raw name.

## Affected / new files

- `supabase/migrations/espn_event_id.sql` — new column.
- `supabase/migrations/schedule_sync_espn_live.sql` — pg_cron job.
- `FINAL/edge-functions/sync-espn-live/index.ts` — new function (source mirror).
- Deployed Supabase edge function `sync-espn-live`.
- (No change required to `index.html` for settlement — it already reads `scorer_result`.)
