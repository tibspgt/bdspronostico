# Group Consensus Stats — Design

**Date:** 2026-07-02
**App:** BDS Pronostico (World Cup 2026 predictions, ~10 friends)
**Status:** Approved (design), ready for implementation plan

## Goal

Add fun, aggregate "crowd wisdom" stats derived from everyone's predictions:

- Most-picked goal scorer
- Most-picked man of the match (MOTM)
- The group's tournament-winner favorite (which team, and what % of players backed it)
- Which teams the group collectively believes will win
- Per-match consensus (e.g. "80% predicted X to win") shown on a match **after it locks**

## Key product decisions

1. **Per-match consensus is shown only after a match locks** (`m.status === 'live'` or
   `'finished'`). Never on upcoming matches — this prevents a herd/copy effect and
   preserves independent guessing.
2. **Tournament-wide / global consensus (winner favorite, most-picked scorer/MOTM, team
   belief) is always visible** — it is not tied to a single match, so there is no spoiler
   concern.
3. **Placement:** the existing "Classement" tab becomes three internal sub-tabs. The new
   consensus stats live in a dedicated sub-tab.

## Approach (chosen: A — pure client-side)

All required raw data is already loaded into the client `state` object on init and kept
fresh by existing realtime subscriptions:

- `state.allPredictions` — every player's score prediction per match
- `state.scorerBets` — every player's scorer pick per match
- `state.motmBets` — every player's MOTM pick per match
- `state.specialBets` — tournament-winner + Ballon d'Or / Soulier d'Or / etc. picks
- `state.matches` — match metadata incl. `status`, teams, flags
- `state.squads` — national-team rosters (for scorer/MOTM name → team matching)

Therefore all stats are computed **in-browser via pure helper functions**. No database
changes, no new edge functions, no new network calls.

**Why not the alternatives:**
- *Global-only (drop per-match block):* loses the "80% predicted X" moment on the match
  card, which is a core part of the ask.
- *Precompute in Supabase (view / edge function):* the app's Supabase project lives on an
  account unreachable from this environment (functions are redeployed by hand by Lucas),
  so a backend approach adds deploy friction and risk for no benefit at ~10 players.

## Architecture

### 1. Classement tab → 3 sub-tabs

Split the current single `#classement-full` container into a segmented control:

- New state: `state.classementSubtab` (default `'classement'`).
- New handler: `setClassementSubtab(key)` updates state and re-renders.
- `renderClassementFull()` renders the segmented control + the active segment only.

Segments:

| Key          | Label                 | Content                                                        |
|--------------|-----------------------|---------------------------------------------------------------|
| `classement` | Classement            | Full leaderboard rows (`renderLbRow`) + TRAJECTOIRES chart     |
| `stats`      | Stats joueurs         | Existing `renderCategoryLeaderboards()` (CLASSEMENTS SPÉCIAUX) |
| `consensus`  | Pronostics du groupe  | New `renderConsensus()` (see §2)                               |

The TRAJECTOIRES evolution chart moves into the `classement` segment. The existing
`setTimeout(renderEvolutionChart, 0)` must only run when that segment is active (the
`<canvas>` only exists then).

Existing realtime handlers already call `renderClassementFull()` on prediction / player /
special-bet / motm / scorer changes, so all three sub-tabs stay live with no extra wiring.

### 2. Consensus sub-tab — `renderConsensus()`

Blocks, each with its own empty state ("Pas encore de pronostics") when it has no data:

1. **🏆 Le favori du groupe** — from `computeWinnerVotes()`: tally `specialBets` where
   `category === 'vainqueur'` by answer (team), ranked bars showing % (of players who bet)
   and vote count.
2. **⚽ Le buteur le plus attendu** — from `computeTopScorerPicks()`: tally all
   `scorerBets` picks by player name across all matches; top 5 with counts.
3. **🟣 L'homme du match le plus choisi** — from `computeTopMotmPicks()`: tally all
   `motmBets` picks by player name across all matches; top 5 with counts.
4. **✅ Les équipes en qui le groupe croit** — from `computeTeamWinBelief()`: across all
   predictions, count how often each team is the predicted winner (draws excluded); ranked
   board with counts.
5. **⭐ Consensus des autres bonus** — from `computeSpecialConsensus(category)` for each
   remaining special category (`meilleur_joueur`, `meilleur_buteur`, `meilleur_gardien`,
   `meilleur_passeur`, `meilleur_jeune`): most-picked answer, one compact line each.

### 3. Per-match consensus block — `renderMatchConsensus(m)`

Rendered inside `renderMatchCard(m)` **only when** `m.status === 'live' || m.status ===
'finished'` **and** at least one prediction exists for the match. A compact "CONSENSUS DU
GROUPE" block from `computeMatchConsensus(matchId)`:

- **Résultat prédit:** outcome distribution among predictions on that match, e.g.
  `🇫🇷 80% · Nul 10% · 🇦🇷 10%`. Percentages are relative to the number of predictions on
  that match (`n`), not the total number of players.
- **Buteur le plus choisi:** e.g. `Mbappé (6)`.
- **MOTM le plus choisi:** e.g. `Mbappé (4)`.

Upcoming matches render nothing (no-spoiler rule).

### 4. Pure helper functions

Read `state`, return plain data, no DOM. Kept pure so they are easy to reason about and
shared between the sub-tab and the match card:

- `computeWinnerVotes()` → `[{ team, count, pct }]`
- `computeTopScorerPicks()` → `[{ name, count }]`
- `computeTopMotmPicks()` → `[{ name, count }]`
- `computeTeamWinBelief()` → `[{ team, winVotes }]`
- `computeSpecialConsensus(category)` → `{ answer, count } | null`
- `computeMatchConsensus(matchId)` → `{ outcomeDist: { home, draw, away }, topScorer, topMotm, n }`

Scorer/MOTM name normalization reuses the existing squad-matching pattern from
`buildScorerLine` (case-insensitive substring match against `state.squads`).

## Edge cases

- No data yet for a block → friendly empty state, block still renders.
- Draw predictions count toward "Nul", never toward a team.
- Ties are sorted stably (deterministic order).
- Percentages rounded to whole numbers against the correct denominator (predictions on the
  match for per-match; players who bet for the winner favorite).
- Skip `AUCUN_BUT` and empty/blank scorer/MOTM picks when tallying.
- `state.classementSubtab` defaults to `'classement'` so existing users see the leaderboard
  first.

## Testing

The front-end is a single monolithic `index.html` with no JS test harness. Verification
follows the project's established Playwright MCP workflow (see `.playwright-mcp/`):

- Load the app against real Supabase data.
- Confirm the three Classement sub-tabs switch correctly and each renders its content.
- Confirm the consensus blocks show plausible counts/percentages.
- Confirm the per-match consensus block appears on live/finished matches and is absent on
  upcoming matches.
- Sanity-check the pure helpers against the loaded `state` values.

No database or edge-function changes are made, so there is nothing to redeploy.

## Out of scope

- Any backend / Supabase schema or edge-function change.
- Historical trend of consensus over time.
- Per-player "who others think will win the league" meta-prediction (no data source).
