# Classements spéciaux — Category leaderboards

**Date:** 2026-06-25
**App:** BDS Pronostico (`FINAL/index.html`)
**Status:** Approved design

## Goal

Add per-category leaderboards to the **Classement** tab so the group can see who
leads on specific skills, not just total points: most exact scores, most correct
MOTM picks, most correct scorers, most good-gap calls, most correct-winner calls.

## Scope

- Additive change to a single file: `FINAL/index.html`.
- No database schema changes, no edge-function changes.
- No new computation: every stat already exists per player.

## Data source

`getSortedPlayers()` already returns, for each player object:

| Field         | Meaning                                  | Board |
|---------------|------------------------------------------|-------|
| `exact`       | count of 4-pt exact-score predictions    | Scores exacts |
| `motmOk`      | count of correct Man-of-the-Match picks  | Homme du match |
| `scorerCount` | count of correct goalscorer picks        | Buteurs |
| `gap`         | count of 2-pt good-gap calls             | Bon écart |
| `win`         | count of 1-pt winner-only calls          | Bon vainqueur |

Also available on each player: `id`, `name`, `emoji`, `color`, `avatar_url`,
`points`, `me`.

## The 5 boards

Driven by a single config array `CATEGORY_BOARDS` so the set is easy to reorder
or extend:

```
[
  { key:'exact',       label:'Scores exacts',  icon:'🎯', color:'rgba(232,160,32,0.9)',  field:'exact',       unit:'exacts'     },
  { key:'motmOk',      label:'Homme du match', icon:'🟣', color:'rgba(168,85,247,0.9)',  field:'motmOk',      unit:'MOTM'       },
  { key:'scorerCount', label:'Buteurs',        icon:'⚽', color:'rgba(16,192,224,0.9)',  field:'scorerCount', unit:'buteurs'    },
  { key:'gap',         label:'Bon écart',      icon:'📏', color:'rgba(80,224,160,0.9)',  field:'gap',         unit:'écarts'     },
  { key:'win',         label:'Bon vainqueur',  icon:'✅', color:'rgba(120,150,240,0.9)', field:'win',         unit:'vainqueurs' },
]
```

## Ranking rules

For each board:
- Sort players by `board.field` descending.
- **Tie-break:** equal counts ordered by total `points` descending.
- **Top-3 view (default):** show the first 3 players, even if a count is 0.
- **Expanded view:** show the full ranked list. Players with a count of 0 appear
  at the bottom, greyed (`opacity:0.45`).
- The current user's row keeps the existing "me" cyan highlight.
- Each row is clickable → `openPlayerProfile(id)`, matching the main leaderboard.

## Layout & placement

- New section inserted in `renderClassementFull()`, **between** the main ranking
  block and the "Trajectoires" evolution-chart block.
- Section header styled like the existing "Évolution du tournoi" header
  (mono eyebrow label + Bebas Neue heading "CLASSEMENTS SPÉCIAUX").
- Boards laid out in a responsive grid: `repeat(auto-fit, minmax(260px, 1fr))`
  — multiple columns on desktop, single column on mobile.
- Each board card: colored category header (icon + label + small unit caption),
  then top-3 rows, then a "Voir tout ↓" / "Réduire ↑" toggle.

## Expand state & live refresh

The app live-auto-refreshes and re-renders the classement frequently. To stop an
open board snapping shut on refresh:

- Add `expandedCategories: new Set()` to the global `state` object.
- `toggleCategoryBoard(key)` flips the key in that set, then re-renders **only**
  the boards grid (`#category-boards-grid`), not the whole tab — avoids evolution
  chart flicker.
- `renderClassementFull()` reads the set so a full re-render preserves which
  boards are open.

## Functions to add

- `renderCategoryLeaderboards()` → returns the section's outer HTML (heading +
  `#category-boards-grid` containing the inner board HTML). Computes its own
  sorted players via `getSortedPlayers()` so it is callable standalone.
- `renderCategoryBoardsGrid()` → returns just the inner grid HTML (used by both
  the section render and the toggle handler).
- `categoryBoardRow(player, rank, count, color, unit, isZero)` → one compact row.
- `toggleCategoryBoard(key)` → global handler (window-scoped like the other
  `on*` handlers).

## Out of scope (YAGNI)

- No new nav tab.
- No per-board date/round filtering.
- No new animations beyond the existing expand/collapse.
- No persistence of expand state across full page reloads (in-memory only).
