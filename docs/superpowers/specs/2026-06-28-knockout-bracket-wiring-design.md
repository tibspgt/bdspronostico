# Knockout bracket wiring — WC2026

**Date:** 2026-06-28
**App:** BDS Pronostico (`FINAL/index.html` + `supabase/functions/sync-espn-live/index.ts`)
**Status:** Approved design

## Goal

Wire the WC2026 knockout bracket so that, once the 16 Round-of-32 matchups are
entered, every later round (Round of 16 → Final) fills itself automatically as
results land — including matches decided on penalties. Make the rest of this
tournament hands-off.

## Background — what already exists

`resolveKnockoutSlots()` ([FINAL/index.html](../../FINAL/index.html)) is a working
bracket engine. Each knockout match can carry a `knockout_rule` JSON `{h, a}`
where each side is a code:
- `1A`/`2B` — 1st/2nd of a group
- `3BEST_n` — nth best third-placed team (by rank)
- `W73` / `L73` — winner / loser of match 73

After every score update it recomputes group standings + best thirds and fills any
`TBD` home/away slots whose `knockout_rule` codes now resolve. It is called in
realtime and via a manual "trigger resolve" button.

**The gap:** every knockout match (ids 73–104) currently has
`knockout_rule = null` and `home/away = TBD`. The engine has never been wired.

## DB structure (confirmed)

| Round | match_group | ids | count |
|---|---|---|---|
| 4 | Seizièmes (Round of 32) | 73–88 | 16 |
| 5 | Huitièmes (Round of 16) | 89–96 | 8 |
| 6 | Quarts | 97–100 | 4 |
| 7 | Demi-finales | 101–102 | 2 |
| 8 | 3e place | 103 | 1 |
| 9 | Finale | 104 | 1 |

The ids match FIFA's official match numbering. Group stage finishes 28/06
(Groups J, K still pending at design time), so the full R32 is not yet knowable.

## Part A — Wire the propagation tree (ids 89–104), now

Set `knockout_rule` (JSON string) on each later-round match, per the official
2026 bracket tree (verified against Wikipedia, two independent reads agree):

| id | knockout_rule |
|---|---|
| 89 | `{"h":"W74","a":"W77"}` |
| 90 | `{"h":"W73","a":"W75"}` |
| 91 | `{"h":"W76","a":"W78"}` |
| 92 | `{"h":"W79","a":"W80"}` |
| 93 | `{"h":"W83","a":"W84"}` |
| 94 | `{"h":"W81","a":"W82"}` |
| 95 | `{"h":"W86","a":"W88"}` |
| 96 | `{"h":"W85","a":"W87"}` |
| 97 | `{"h":"W89","a":"W90"}` |
| 98 | `{"h":"W93","a":"W94"}` |
| 99 | `{"h":"W91","a":"W92"}` |
| 100 | `{"h":"W95","a":"W96"}` |
| 101 | `{"h":"W97","a":"W98"}` |
| 102 | `{"h":"W99","a":"W100"}` |
| 103 | `{"h":"L101","a":"L102"}` |
| 104 | `{"h":"W101","a":"W102"}` |

Home/away ordering is cosmetic (neutral venues) and follows the official listing.
Written directly via the app's anon REST key (the `matches` table is writable).
Safe to write now: slots stay `TBD` until their feeder results exist.

## Part B — Penalty-aware winner resolution

A knockout never ends in a draw; if level after extra time, penalties decide it.
Two coordinated changes:

### B1 — ESPN sync populates `penalty_winner` (`index.ts`) — Lucas redeploys by hand
`parseSummary` already reads ESPN competitors and excludes shootout goals
(period > 4) from scorers. Add extraction of the shootout/overall winner from
ESPN's authoritative competitor `winner` flag (fallback: `shootoutScore`
comparison). In the writer, when a match is `finished` **and** the score is level,
persist `penalty_winner` = `'home'` | `'away'`.

### B2 — Resolver respects `penalty_winner` (`index.html resolveTeam`) — deploys via GitHub push
For `W`/`L` codes, currently the advancing side is chosen by
`score_home > score_away`, which is wrong for a level-then-penalties result.
New logic for a finished source match:
- If `score_home !== score_away`: winner = higher score (unchanged).
- Else if `penalty_winner` is set: winner = `penalty_winner` side; loser = other.
- Else (level, no penalty winner recorded yet): **return null** — leave the slot
  `TBD` rather than propagate a phantom draw. It resolves on the next sync once
  ESPN reports the shootout winner.

## Part C — Enter the 16 R32 matchups (ids 73–88), after group stage ends

Deferred until Lucas confirms all group matches are finished (morning of 29/06).
Then: fetch the official R32 fixtures, map each FIFA match number to the matching
DB id (73→73 …), verify by date, present the 16 pairings for confirmation, and
write `home`/`away`/`home_flag`/`away_flag` directly. Parts A+B then carry the
rest of the tournament automatically.

## Deploy paths (see [[bds-pronostico-deploy]])

- Part A: DB writes via REST — effective immediately, no deploy.
- Part B2 (`index.html`): commit + push to GitHub main (PWA redeploy).
- Part B1 (`index.ts`): Lucas redeploys the edge function by hand (separate
  Supabase account, not reachable via CLI/MCP).

Both Part B changes should be live before the first R32 knockout that could go to
penalties (R32 starts 29/06).

## Out of scope (YAGNI)

- No FIFA thirds-assignment matrix (Lucas chose direct R32 entry).
- No generic multi-tournament bracket-config layer.
- No new UI — existing realtime + "trigger resolve" button drive it.
