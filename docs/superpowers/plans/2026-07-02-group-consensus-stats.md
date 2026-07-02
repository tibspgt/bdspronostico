# Group Consensus Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add crowd-wisdom stats (most-picked scorer/MOTM, tournament-winner favorite, team win-belief, per-match consensus) computed entirely in the browser from data already loaded in `state`.

**Architecture:** Pure computation helpers live in a new testable module `FINAL/consensus.js` (unit-tested with Node's built-in test runner). The DOM-rendering functions stay inline in `FINAL/index.html`, following the existing monolithic pattern. The "Classement" tab is split into three sub-tabs (leaderboard / player stats / consensus); a compact consensus block is added to match cards but only after a match locks.

**Tech Stack:** Vanilla JS (no build step), Supabase JS client (already loaded), Chart.js (already loaded), Node `node --test` for unit tests. No database or edge-function changes.

## Global Constraints

- No database schema changes, no new edge functions, no new network calls. All stats derive from existing `state`: `state.allPredictions`, `state.scorerBets`, `state.motmBets`, `state.specialBets`, `state.matches`, `state.squads`, `state.players`.
- Per-match consensus is shown **only when `m.status === 'live' || m.status === 'finished'`** and at least one prediction exists. Never on upcoming matches (no-spoiler rule).
- Follow the existing code style: inline styles in HTML template strings, `var(--…)` CSS custom properties, French UI copy.
- Field names are fixed by the DB: `predictions{player_id, match_id, score_home, score_away, penalty_pick}`, `scorer_bets{player_id, match_id, pick_player_name, pick_position}`, `motm_bets{player_id, match_id, pick_player_name}`, `special_bets{player_id, category, pick}`, `matches{id, home, away, home_flag, away_flag, status, score_home, score_away}`, `squads{team_name, player_name, position}`.
- The `scorer_bets` "no goal" sentinel is the string `'AUCUN_BUT'` and must be excluded from "most-picked scorer" tallies.
- All working directories referenced are under `FINAL/` unless stated otherwise. Run Node commands from `FINAL/`.

---

### Task 1: Pure consensus computation module (`consensus.js`) + unit tests

**Files:**
- Create: `FINAL/consensus.js`
- Test: `FINAL/consensus.test.js`

**Interfaces:**
- Consumes: nothing (pure functions over plain arrays/objects).
- Produces (all attached to `globalThis.Consensus` in the browser and `module.exports` under Node):
  - `computeWinnerVotes(specialBets) → [{ team:string, count:number, pct:number }]` (desc)
  - `computeTopPicks(bets, limit=5) → [{ name:string, count:number }]` (desc; `bets` items have `pick_player_name`)
  - `computeSpecialConsensus(specialBets, category) → { answer:string, count:number } | null`
  - `computeTeamWinBelief(predictions, matches, limit=8) → [{ team:string, winVotes:number }]` (desc)
  - `computeMatchConsensus({ matchId, match, predictions, scorerBets, motmBets }) → { n:number, outcomeDist:{home:number,draw:number,away:number}, topScorer:{name,count}|null, topMotm:{name,count}|null }`
  - `tally(names) → [{ name, count }]`, `predictedSide(pred) → 'home'|'away'|'draw'`

- [ ] **Step 1: Write the failing tests**

Create `FINAL/consensus.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const C = require('./consensus.js');

test('computeWinnerVotes tallies votes and percentages, ignores other categories', () => {
  const bets = [
    { player_id: 'a', category: 'vainqueur', pick: 'France' },
    { player_id: 'b', category: 'vainqueur', pick: 'France' },
    { player_id: 'c', category: 'vainqueur', pick: 'Brésil' },
    { player_id: 'd', category: 'vainqueur', pick: 'France' },
    { player_id: 'e', category: 'meilleur_buteur', pick: 'Mbappé' },
  ];
  assert.deepStrictEqual(C.computeWinnerVotes(bets), [
    { team: 'France', count: 3, pct: 75 },
    { team: 'Brésil', count: 1, pct: 25 },
  ]);
});

test('computeWinnerVotes returns [] with no votes', () => {
  assert.deepStrictEqual(C.computeWinnerVotes([]), []);
});

test('computeTopPicks skips AUCUN_BUT and blanks, sorts by count then name', () => {
  const bets = [
    { pick_player_name: 'Mbappé' },
    { pick_player_name: 'Mbappé' },
    { pick_player_name: 'AUCUN_BUT' },
    { pick_player_name: '' },
    { pick_player_name: 'Haaland' },
  ];
  assert.deepStrictEqual(C.computeTopPicks(bets), [
    { name: 'Mbappé', count: 2 },
    { name: 'Haaland', count: 1 },
  ]);
});

test('computeSpecialConsensus returns top answer or null', () => {
  const bets = [
    { category: 'meilleur_joueur', pick: 'Messi' },
    { category: 'meilleur_joueur', pick: 'Messi' },
    { category: 'meilleur_joueur', pick: 'Mbappé' },
  ];
  assert.deepStrictEqual(C.computeSpecialConsensus(bets, 'meilleur_joueur'), { answer: 'Messi', count: 2 });
  assert.strictEqual(C.computeSpecialConsensus(bets, 'meilleur_gardien'), null);
});

test('computeTeamWinBelief counts predicted winners, skips draws and TBD', () => {
  const matches = [
    { id: 1, home: 'France', away: 'Brésil' },
    { id: 2, home: 'Espagne', away: 'TBD' },
  ];
  const predictions = [
    { match_id: 1, score_home: 2, score_away: 0 },
    { match_id: 1, score_home: 1, score_away: 1 },
    { match_id: 1, score_home: 0, score_away: 3 },
    { match_id: 2, score_home: 5, score_away: 0 },
    { match_id: 2, score_home: 0, score_away: 1 },
  ];
  assert.deepStrictEqual(C.computeTeamWinBelief(predictions, matches), [
    { team: 'Brésil', winVotes: 1 },
    { team: 'Espagne', winVotes: 1 },
    { team: 'France', winVotes: 1 },
  ]);
});

test('computeMatchConsensus computes distribution and top picks for one match', () => {
  const match = { id: 1, home: 'France', away: 'Brésil' };
  const predictions = [
    { match_id: 1, score_home: 2, score_away: 0 },
    { match_id: 1, score_home: 1, score_away: 0 },
    { match_id: 1, score_home: 1, score_away: 1 },
    { match_id: 1, score_home: 0, score_away: 2 },
    { match_id: 2, score_home: 9, score_away: 0 },
  ];
  const scorerBets = [
    { match_id: 1, pick_player_name: 'Mbappé' },
    { match_id: 1, pick_player_name: 'Mbappé' },
    { match_id: 1, pick_player_name: 'AUCUN_BUT' },
  ];
  const motmBets = [{ match_id: 1, pick_player_name: 'Griezmann' }];
  const res = C.computeMatchConsensus({ matchId: 1, match, predictions, scorerBets, motmBets });
  assert.strictEqual(res.n, 4);
  assert.deepStrictEqual(res.outcomeDist, { home: 50, draw: 25, away: 25 });
  assert.deepStrictEqual(res.topScorer, { name: 'Mbappé', count: 2 });
  assert.deepStrictEqual(res.topMotm, { name: 'Griezmann', count: 1 });
});

test('computeMatchConsensus with no predictions returns zeros and nulls', () => {
  const res = C.computeMatchConsensus({ matchId: 99, match: { id: 99, home: 'A', away: 'B' }, predictions: [], scorerBets: [], motmBets: [] });
  assert.strictEqual(res.n, 0);
  assert.deepStrictEqual(res.outcomeDist, { home: 0, draw: 0, away: 0 });
  assert.strictEqual(res.topScorer, null);
  assert.strictEqual(res.topMotm, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test consensus.test.js` (from `FINAL/`)
Expected: FAIL — `Cannot find module './consensus.js'`.

- [ ] **Step 3: Write the module**

Create `FINAL/consensus.js`:

```js
/**
 * Consensus stat computations for BDS Pronostico.
 * Pure functions — no DOM, no globals read. Loads as a classic <script> in the
 * browser (attaches `Consensus` to globalThis) and as a CommonJS module in Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Consensus = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Tally an array of raw strings into [{name,count}] sorted by count desc, then name.
  function tally(names) {
    const counts = new Map();
    for (const raw of names) {
      const name = (raw || '').trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'fr'));
  }

  // Most-picked scorer/MOTM names (both tables use pick_player_name).
  // Skips the "no goal" sentinel and blanks.
  function computeTopPicks(bets, limit = 5) {
    const names = (bets || [])
      .map(b => b.pick_player_name)
      .filter(n => n && n !== 'AUCUN_BUT');
    const ranked = tally(names);
    return limit ? ranked.slice(0, limit) : ranked;
  }

  // Tournament-winner votes from special_bets (category 'vainqueur').
  function computeWinnerVotes(specialBets) {
    const picks = (specialBets || [])
      .filter(b => b.category === 'vainqueur' && b.pick && b.pick.trim())
      .map(b => b.pick.trim());
    const total = picks.length;
    return tally(picks).map(({ name, count }) => ({
      team: name,
      count,
      pct: total ? Math.round((count / total) * 100) : 0,
    }));
  }

  // Most-picked answer for a given special_bets category.
  function computeSpecialConsensus(specialBets, category) {
    const picks = (specialBets || [])
      .filter(b => b.category === category && b.pick && b.pick.trim())
      .map(b => b.pick.trim());
    const ranked = tally(picks);
    return ranked.length ? { answer: ranked[0].name, count: ranked[0].count } : null;
  }

  // Which side a prediction backs: 'home' | 'away' | 'draw'.
  function predictedSide(pred) {
    if (pred.score_home > pred.score_away) return 'home';
    if (pred.score_home < pred.score_away) return 'away';
    return 'draw';
  }

  // Teams ranked by how often the group predicted them to win (draws & TBD excluded).
  function computeTeamWinBelief(predictions, matches, limit = 8) {
    const matchById = new Map((matches || []).map(m => [m.id, m]));
    const votes = new Map();
    for (const pred of predictions || []) {
      if (pred.score_home == null || pred.score_away == null) continue;
      const m = matchById.get(pred.match_id);
      if (!m) continue;
      const side = predictedSide(pred);
      if (side === 'draw') continue;
      const team = side === 'home' ? m.home : m.away;
      if (!team || team === 'TBD') continue;
      votes.set(team, (votes.get(team) || 0) + 1);
    }
    const ranked = [...votes.entries()]
      .map(([team, winVotes]) => ({ team, winVotes }))
      .sort((a, b) => b.winVotes - a.winVotes || a.team.localeCompare(b.team, 'fr'));
    return limit ? ranked.slice(0, limit) : ranked;
  }

  // Per-match consensus: outcome distribution (integer %) + top scorer/MOTM pick.
  function computeMatchConsensus({ matchId, predictions, scorerBets, motmBets }) {
    const preds = (predictions || []).filter(
      p => p.match_id === matchId && p.score_home != null && p.score_away != null
    );
    const n = preds.length;
    let home = 0, away = 0, draw = 0;
    for (const p of preds) {
      const side = predictedSide(p);
      if (side === 'home') home++;
      else if (side === 'away') away++;
      else draw++;
    }
    const pct = c => (n ? Math.round((c / n) * 100) : 0);
    const topScorer = computeTopPicks((scorerBets || []).filter(b => b.match_id === matchId), 1)[0] || null;
    const topMotm   = computeTopPicks((motmBets   || []).filter(b => b.match_id === matchId), 1)[0] || null;
    return { n, outcomeDist: { home: pct(home), draw: pct(draw), away: pct(away) }, topScorer, topMotm };
  }

  return {
    tally,
    computeTopPicks,
    computeWinnerVotes,
    computeSpecialConsensus,
    computeTeamWinBelief,
    computeMatchConsensus,
    predictedSide,
  };
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test consensus.test.js` (from `FINAL/`)
Expected: PASS — 7 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add FINAL/consensus.js FINAL/consensus.test.js
git commit -m "feat: add pure consensus computation module with unit tests"
```

---

### Task 2: Load module, add sub-tab state, split Classement into sub-tabs

**Files:**
- Modify: `FINAL/index.html:3601` (add script include)
- Modify: `FINAL/index.html:3894` (add state field)
- Modify: `FINAL/index.html:5469-5498` (replace `renderClassementFull`, add `setClassementSubtab`)

**Interfaces:**
- Consumes: `Consensus.*` (Task 1), existing `getSortedPlayers()`, `renderLbRow()`, `renderCategoryLeaderboards()`, `renderEvolutionChart()`, and `renderConsensus()` (Task 3 — a stub is added here and fleshed out in Task 3).
- Produces: `state.classementSubtab`, global `setClassementSubtab(key)`, restructured `renderClassementFull()`.

- [ ] **Step 1: Add the module script include**

In `FINAL/index.html`, after line 3601 (`<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>`) and before line 3602 (`<script>`), insert:

```html
<script src="consensus.js"></script>
```

- [ ] **Step 2: Add sub-tab state field**

In the `state` object (around line 3894), the last field is:

```js
  expandedCategories: new Set(), // classements spéciaux dépliés
```

Change it to:

```js
  expandedCategories: new Set(), // classements spéciaux dépliés
  classementSubtab: 'classement', // sous-onglet actif de l'onglet Classement
```

- [ ] **Step 3: Add a temporary `renderConsensus` stub**

So the app runs before Task 3, add this stub immediately above `function renderClassementFull()` (line 5469):

```js
function renderConsensus() {
  return '<div style="background:var(--surface);border:1px solid var(--border-soft);padding:1.5rem;margin-top:1rem;font-family:\'Barlow Condensed\',sans-serif;color:var(--text-muted);">Consensus à venir…</div>';
}
```

- [ ] **Step 4: Replace `renderClassementFull` and add `setClassementSubtab`**

Replace the entire current function (lines 5469-5498) with:

```js
function renderClassementFull() {
  const sub = state.classementSubtab || 'classement';
  const tabs = [
    { key: 'classement', label: 'Classement' },
    { key: 'stats',      label: 'Stats joueurs' },
    { key: 'consensus',  label: 'Pronostics du groupe' },
  ];
  const nav = `
    <div style="display:flex;gap:0.4rem;margin-bottom:1rem;flex-wrap:wrap;">
      ${tabs.map(t => `
        <button onclick="setClassementSubtab('${t.key}')" style="
          flex:1;min-width:90px;padding:0.6rem 0.5rem;cursor:pointer;
          font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:0.85rem;
          letter-spacing:0.03em;text-transform:uppercase;border-radius:6px;
          background:${sub === t.key ? 'var(--gold)' : 'rgba(255,255,255,0.03)'};
          color:${sub === t.key ? '#000' : 'var(--text-muted)'};
          border:1px solid ${sub === t.key ? 'var(--gold)' : 'var(--border-soft)'};">${t.label}</button>`).join('')}
    </div>`;

  let body = '';
  if (sub === 'classement') {
    const sorted = getSortedPlayers();
    let lb = '<div style="background:var(--surface);border:1px solid var(--border-soft);">';
    if (sorted.length === 0) {
      lb += '<div class="empty-state" style="padding:2rem;"><div class="empty-title">Aucun joueur</div><div class="empty-text">Rejoins la ligue pour apparaître ici</div></div>';
    } else {
      sorted.forEach((p, i) => { lb += renderLbRow(p, i + 1, true); });
    }
    lb += '</div>';
    body = lb + `
      <div style="background:var(--surface);border:1px solid var(--border-soft);padding:1.5rem;margin-top:1rem;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem;">
          <div>
            <div style="font-family:'Azeret Mono',monospace;font-size:0.58rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.3rem;">Évolution du tournoi</div>
            <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;color:var(--gold);letter-spacing:0.04em;margin:0;">TRAJECTOIRES</h3>
          </div>
          <span id="chart-mode-badge" style="font-family:'Azeret Mono',monospace;font-size:0.52rem;background:rgba(255,255,255,0.03);border:1px solid var(--border-soft);padding:0.25rem 0.65rem;"></span>
        </div>
        <div style="position:relative;height:420px;">
          <canvas id="evolution-chart"></canvas>
        </div>
      </div>`;
  } else if (sub === 'stats') {
    body = renderCategoryLeaderboards();
  } else {
    body = renderConsensus();
  }

  document.getElementById('classement-full').innerHTML = nav + body;
  if (sub === 'classement') setTimeout(renderEvolutionChart, 0);
}

function setClassementSubtab(key) {
  state.classementSubtab = key;
  renderClassementFull();
}
```

- [ ] **Step 5: Verify in the browser (Playwright MCP)**

1. `browser_navigate` to `file:///c:/Users/lucas/OneDrive/Documents/INSCALED/CLAUDE APP/World Cup Tiktoks/bdspronostico/FINAL/index.html`.
2. `browser_click` the "Classement" nav tab.
3. Confirm three sub-tab buttons render: "Classement", "Stats joueurs", "Pronostics du groupe".
4. Default sub-tab is "Classement": leaderboard rows + TRAJECTOIRES chart visible.
5. `browser_click` "Stats joueurs" → the existing CLASSEMENTS SPÉCIAUX boards show.
6. `browser_click` "Pronostics du groupe" → the "Consensus à venir…" stub shows.
7. `browser_console_messages` shows no errors.
8. `browser_click` "Classement" again → chart re-renders (no error).

Expected: sub-tabs switch cleanly, no console errors.

- [ ] **Step 6: Commit**

```bash
git add FINAL/index.html
git commit -m "feat: split Classement tab into sub-tabs and load consensus module"
```

---

### Task 3: Build the consensus sub-tab (`renderConsensus`)

**Files:**
- Modify: `FINAL/index.html` (replace the `renderConsensus` stub from Task 2; add `consensusTopList` helper)

**Interfaces:**
- Consumes: `Consensus.computeWinnerVotes`, `Consensus.computeTopPicks`, `Consensus.computeTeamWinBelief`, `Consensus.computeSpecialConsensus` (Task 1); existing global `SPECIAL_CATEGORIES` (line 3863); `state.specialBets`, `state.scorerBets`, `state.motmBets`, `state.allPredictions`, `state.matches`.
- Produces: full `renderConsensus()` returning the five stat blocks; helper `consensusTopList(items, color)`.

- [ ] **Step 1: Replace the stub with the full implementation**

Replace the `renderConsensus` stub (added in Task 2) with:

```js
function consensusTopList(items, color) {
  return items.map((it, i) => `
    <div style="display:flex;align-items:center;gap:0.6rem;padding:0.4rem 0;border-bottom:1px solid var(--border-soft);">
      <span style="width:18px;text-align:center;font-family:'Bebas Neue',sans-serif;color:var(--text-muted);">${i + 1}</span>
      <span style="flex:1;font-family:'Barlow Condensed',sans-serif;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${it.name || it.team}</span>
      <span style="font-family:'Bebas Neue',sans-serif;color:${color};font-size:1.1rem;flex-shrink:0;">${it.count != null ? it.count : it.winVotes}</span>
    </div>`).join('');
}

function renderConsensus() {
  const card = 'background:var(--surface);border:1px solid var(--border-soft);padding:1.25rem;margin-top:1rem;';
  const hdr = (kicker, title, color) => `
    <div style="margin-bottom:1rem;">
      <div style="font-family:'Azeret Mono',monospace;font-size:0.55rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.3rem;">${kicker}</div>
      <h3 style="font-family:'Bebas Neue',sans-serif;font-size:1.3rem;color:${color || 'var(--gold)'};letter-spacing:0.04em;margin:0;">${title}</h3>
    </div>`;
  const empty = txt => `<div style="font-family:'Barlow Condensed',sans-serif;color:var(--text-muted);font-size:0.9rem;padding:0.5rem 0;">${txt}</div>`;
  const NONE = 'Pas encore de pronostics';

  // 1. Favori du groupe (tournament-winner votes)
  const winners = Consensus.computeWinnerVotes(state.specialBets);
  const winnerHtml = winners.length ? winners.map(w => `
    <div style="margin-bottom:0.6rem;">
      <div style="display:flex;justify-content:space-between;font-family:'Barlow Condensed',sans-serif;font-size:0.95rem;margin-bottom:0.2rem;">
        <span style="font-weight:700;">${w.team}</span>
        <span style="color:var(--gold);">${w.pct}% · ${w.count} vote${w.count > 1 ? 's' : ''}</span>
      </div>
      <div style="height:6px;background:rgba(255,255,255,0.05);border-radius:3px;overflow:hidden;">
        <div style="height:100%;width:${w.pct}%;background:var(--gold);"></div>
      </div>
    </div>`).join('') : empty(NONE);

  // 2. Buteur le plus attendu
  const scorers = Consensus.computeTopPicks(state.scorerBets);
  const scorerHtml = scorers.length ? consensusTopList(scorers, 'var(--cyan-bright)') : empty(NONE);

  // 3. Homme du match le plus choisi
  const motms = Consensus.computeTopPicks(state.motmBets);
  const motmHtml = motms.length ? consensusTopList(motms, 'rgba(168,85,247,0.9)') : empty(NONE);

  // 4. Équipes en qui le groupe croit
  const teams = Consensus.computeTeamWinBelief(state.allPredictions, state.matches);
  const teamHtml = teams.length ? consensusTopList(teams, 'var(--green)') : empty(NONE);

  // 5. Consensus des autres bonus
  const otherHtml = SPECIAL_CATEGORIES.filter(c => c.key !== 'vainqueur').map(cat => {
    const cons = Consensus.computeSpecialConsensus(state.specialBets, cat.key);
    return `
      <div style="display:flex;align-items:center;gap:0.5rem;padding:0.4rem 0;border-bottom:1px solid var(--border-soft);">
        <span style="font-size:0.95rem;">${cat.icon}</span>
        <span style="flex:1;font-family:'Barlow Condensed',sans-serif;font-size:0.9rem;color:var(--text-muted);">${cat.label}</span>
        <span style="font-family:'Barlow Condensed',sans-serif;font-weight:700;text-align:right;">${cons ? `${cons.answer} <span style="color:var(--text-muted);font-size:0.75rem;">(${cons.count})</span>` : '—'}</span>
      </div>`;
  }).join('');

  return `
    <div style="${card}">${hdr('Le favori du groupe', '🏆 VAINQUEUR DU TOURNOI')}${winnerHtml}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem;">
      <div style="${card}">${hdr('Le plus attendu', '⚽ BUTEUR', 'var(--cyan-bright)')}${scorerHtml}</div>
      <div style="${card}">${hdr('Le plus choisi', '🟣 HOMME DU MATCH', 'rgba(168,85,247,0.9)')}${motmHtml}</div>
    </div>
    <div style="${card}">${hdr('Qui le groupe voit gagner', '✅ ÉQUIPES EN QUI LE GROUPE CROIT', 'var(--green)')}${teamHtml}</div>
    <div style="${card}">${hdr('Consensus', '⭐ AUTRES BONUS')}${otherHtml}</div>`;
}
```

- [ ] **Step 2: Verify in the browser (Playwright MCP)**

1. `browser_navigate` to the local `FINAL/index.html`.
2. `browser_click` "Classement" → `browser_click` "Pronostics du groupe".
3. Confirm five blocks render: VAINQUEUR DU TOURNOI (bars with %), BUTEUR, HOMME DU MATCH, ÉQUIPES EN QUI LE GROUPE CROIT, AUTRES BONUS.
4. `browser_snapshot` and sanity-check: winner percentages are 0-100 and the bar widths match; scorer/MOTM/team lists show names with integer counts; blocks with no data show "Pas encore de pronostics".
5. `browser_console_messages` shows no errors.

Expected: all five blocks render with plausible numbers, no console errors.

- [ ] **Step 3: Commit**

```bash
git add FINAL/index.html
git commit -m "feat: build group consensus sub-tab (winner/scorer/MOTM/team/bonus)"
```

---

### Task 4: Per-match consensus block on match cards (after lock)

**Files:**
- Modify: `FINAL/index.html` (add `renderMatchConsensus`; inject into `renderMatchCard` return at line 5135)

**Interfaces:**
- Consumes: `Consensus.computeMatchConsensus` (Task 1); `state.allPredictions`, `state.scorerBets`, `state.motmBets`; match fields `status, home_flag, away_flag`.
- Produces: `renderMatchConsensus(m)` returning a block string (or `''`), rendered inside each match card.

- [ ] **Step 1: Add `renderMatchConsensus`**

Add this function immediately above `function renderMatchCard(m)` (line 4649):

```js
function renderMatchConsensus(m) {
  if (!(m.status === 'live' || m.status === 'finished')) return '';
  const c = Consensus.computeMatchConsensus({
    matchId: m.id,
    match: m,
    predictions: state.allPredictions,
    scorerBets: state.scorerBets,
    motmBets: state.motmBets,
  });
  if (c.n === 0) return '';
  const flag = code => code ? `<img src="https://flagcdn.com/w20/${code}.png" style="height:10px;border-radius:1px;vertical-align:middle;">` : '';
  const dist = `${flag(m.home_flag)} ${c.outcomeDist.home}% <span style="opacity:0.3;">·</span> Nul ${c.outcomeDist.draw}% <span style="opacity:0.3;">·</span> ${flag(m.away_flag)} ${c.outcomeDist.away}%`;
  const scorerLine = c.topScorer ? `🔥 ${c.topScorer.name} (${c.topScorer.count})` : '';
  const motmLine   = c.topMotm ? `🟣 ${c.topMotm.name} (${c.topMotm.count})` : '';
  const extra = [scorerLine, motmLine].filter(Boolean).join('<span style="opacity:0.3;margin:0 0.4rem;">·</span>');
  return `
    <div style="border-top:1px solid var(--border-soft);padding:0.55rem 0.9rem;">
      <div style="font-family:'Azeret Mono',monospace;font-size:0.52rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:0.3rem;">Consensus du groupe · ${c.n} pronostic${c.n > 1 ? 's' : ''}</div>
      <div style="font-family:'Barlow Condensed',sans-serif;font-size:0.85rem;color:var(--text);">${dist}</div>
      ${extra ? `<div style="font-family:'Barlow Condensed',sans-serif;font-size:0.8rem;color:var(--text-muted);margin-top:0.2rem;">${extra}</div>` : ''}
    </div>`;
}
```

- [ ] **Step 2: Inject into the match card**

In `renderMatchCard`'s return (line 5135), the current last line before the closing `</div>` is:

```js
      ${(motmHtml || scorerHtml) ? `<div class="bets-row">${motmHtml}${scorerHtml}</div>` : ''}
```

Add the consensus block right after it:

```js
      ${(motmHtml || scorerHtml) ? `<div class="bets-row">${motmHtml}${scorerHtml}</div>` : ''}
      ${renderMatchConsensus(m)}
```

- [ ] **Step 3: Verify in the browser (Playwright MCP)**

1. `browser_navigate` to the local `FINAL/index.html`.
2. On the "Matchs" tab, find a match with status live/finished (has a real score shown).
3. Confirm a "CONSENSUS DU GROUPE · N pronostics" block appears on that card with a result distribution (percentages summing to ~100) and, when present, top scorer / top MOTM lines.
4. Confirm an upcoming match (shows a countdown / "VS", no score) has **no** consensus block.
5. `browser_console_messages` shows no errors.

Expected: consensus block only on locked matches, absent on upcoming, no console errors.

- [ ] **Step 4: Commit**

```bash
git add FINAL/index.html
git commit -m "feat: show per-match group consensus on locked match cards"
```

---

## Self-Review

**Spec coverage:**
- Most-picked goal scorer → Task 3 block 2 (`computeTopPicks(scorerBets)`) + Task 4 per-match. ✓
- Most-picked MOTM → Task 3 block 3 + Task 4 per-match. ✓
- Tournament-winner favorite with % ("team voted winner by X%") → Task 3 block 1 (`computeWinnerVotes`). ✓
- Teams the group believes will win → Task 3 block 4 (`computeTeamWinBelief`). ✓
- Other-bonus consensus → Task 3 block 5 (`computeSpecialConsensus`). ✓
- Per-match consensus after lock only → Task 4 (`m.status` live/finished guard). ✓
- Classement 3 sub-tabs (leaderboard / player stats / consensus) → Task 2. ✓
- No DB / edge-function changes → all tasks client-side. ✓
- Empty states, draw handling, %-rounding, AUCUN_BUT skip, tie sorting → Task 1 helpers + tested. ✓
- TRAJECTOIRES chart moved into leaderboard sub-tab, `renderEvolutionChart` only when active → Task 2 Step 4. ✓

**Placeholder scan:** No TBD/TODO; every code step contains full code. The Task 2 `renderConsensus` stub is intentional scaffolding replaced in Task 3, not a placeholder.

**Type consistency:** `computeTopPicks` returns `{name,count}`; `computeTeamWinBelief` returns `{team,winVotes}`; `consensusTopList` handles both via `it.name || it.team` and `it.count != null ? it.count : it.winVotes`. `computeMatchConsensus` returns `{n, outcomeDist:{home,draw,away}, topScorer, topMotm}` — consumed exactly in Task 4. `Consensus.*` names match between `consensus.js` exports and all call sites. Field names (`pick_player_name`, `pick`, `category`, `score_home/away`, `home/away`, `home_flag/away_flag`, `status`) match the DB schema in Global Constraints.
