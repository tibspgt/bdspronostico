# ESPN Goal Scorers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically pull World Cup goal scorers (and live score/status) from ESPN and write them onto each match so 🔥 Buteur bets settle by themselves.

**Architecture:** A new Supabase edge function `sync-espn-live` is triggered every 2 min (inside the match window) by pg_cron + pg_net — the same mechanism the existing `match-reminders` job uses. Each run finds in-window matches, resolves their ESPN event id (cached on the row), fetches the ESPN summary, maps scorer names to the squad roster, and writes `score_home`/`score_away`/`status`/`scorer_result`. Unmatched scorers trigger a push to admins. API-Football is untouched and keeps handling fixture/knockout import.

**Tech Stack:** Supabase (Postgres, Deno edge functions, pg_cron + pg_net), ESPN public `site.api` (no key), `@supabase/supabase-js@2`, `web-push@3` (already used). Tests via `deno test`.

## Global Constraints

- **Squad-facing copy is French.** Push notification text must be in French. (CLAUDE.md language rule.)
- **Favour simplicity; explain what and why.** Beginner-owned project; no clever code without explanation. (CLAUDE.md.)
- **Migrations are applied by hand in the Supabase SQL editor** before any code that reads new columns is deployed.
- **`scorer_result` format is exact:** comma-joined canonical `squads.player_name` values, one entry per goal, ordered by minute; or the literal string `'AUCUN_BUT'` when a finished match had zero qualifying goals. This is what `scorer_bets.pick_player_name` is matched against (`index.html:7732-7736`).
- **Never overwrite a finalised result:** for a `finished` match, only auto-write `scorer_result` when it is currently NULL. While a match is not finished, the function owns and may refresh it.
- **Exclude own goals and penalty-shootout goals** from `scorer_result`.
- **France is CEST (UTC+2)** for the whole tournament; kickoff fields are Paris-local text.
- **ESPN endpoints (FIFA.WORLD):**
  - scoreboard: `https://site.api.espn.com/apis/site/v2/sports/soccer/FIFA.WORLD/scoreboard?dates=YYYYMMDD`
  - summary: `https://site.api.espn.com/apis/site/v2/sports/soccer/FIFA.WORLD/summary?event={id}`
- **Project ref:** `godcigantcuuwnwerxjc` (used in cron URLs, see `schedule_match_reminders.sql`).

---

### Task 1: Add `espn_event_id` column

**Files:**
- Create: `supabase/migrations/espn_event_id.sql`

**Interfaces:**
- Produces: column `matches.espn_event_id text` (nullable) — cached ESPN event id per match.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/espn_event_id.sql`:

```sql
-- Cache de l'identifiant d'événement ESPN pour chaque match.
-- Résolu une seule fois (via le scoreboard ESPN), puis réutilisé à chaque
-- synchro live. Modifiable à la main si un match n'est pas reconnu.
alter table matches
  add column if not exists espn_event_id text;
```

- [ ] **Step 2: Apply it in the Supabase SQL editor**

Paste the file contents into Supabase → SQL Editor → Run. This must happen before Task 6 is deployed.

- [ ] **Step 3: Verify the column exists**

Run in SQL Editor:
```sql
select column_name from information_schema.columns
where table_name = 'matches' and column_name = 'espn_event_id';
```
Expected: one row, `espn_event_id`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/espn_event_id.sql
git commit -m "feat(db): add matches.espn_event_id column for ESPN scorer sync"
```

---

### Task 2: Pure helper module + name-mapping helpers (TDD)

**Files:**
- Create: `supabase/functions/sync-espn-live/espn.ts`
- Test: `supabase/functions/sync-espn-live/espn.test.ts`

**Interfaces:**
- Produces:
  - `normalizeName(s: string): string` — lowercase, strip accents, collapse spaces, trim.
  - `surnameMatch(a: string, b: string): boolean` — true if the last whitespace token of each normalized name is equal.
  - `resolveSquadName(espnName: string, roster: string[]): string | null` — returns the roster entry that best matches `espnName` (exact-normalized → surname → substring), else `null`.

- [ ] **Step 1: Install Deno (one-time, skip if already installed)**

Run (PowerShell): `irm https://deno.land/install.ps1 | iex`
Then verify: `deno --version`
Expected: prints a `deno x.y.z` version line.

- [ ] **Step 2: Write the failing test**

Create `supabase/functions/sync-espn-live/espn.test.ts`:

```ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { normalizeName, surnameMatch, resolveSquadName } from './espn.ts'

Deno.test('normalizeName strips accents, case, extra spaces', () => {
  assertEquals(normalizeName('  Kylian  MBAPPÉ '), 'kylian mbappe')
  assertEquals(normalizeName('Lautaro Martínez'), 'lautaro martinez')
})

Deno.test('surnameMatch compares last token', () => {
  assertEquals(surnameMatch('K. Mbappé', 'Kylian Mbappe'), true)
  assertEquals(surnameMatch('Messi', 'L. Messi'), true)
  assertEquals(surnameMatch('Lautaro Martinez', 'Julian Alvarez'), false)
})

Deno.test('resolveSquadName matches by surname, returns canonical roster name', () => {
  const roster = ['Kylian Mbappé', 'Antoine Griezmann', 'Aurélien Tchouaméni']
  assertEquals(resolveSquadName('K. Mbappé', roster), 'Kylian Mbappé')
  assertEquals(resolveSquadName('Griezmann', roster), 'Antoine Griezmann')
  assertEquals(resolveSquadName('Unknown Player', roster), null)
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd "supabase/functions/sync-espn-live" && deno test --allow-net espn.test.ts`
Expected: FAIL — `Module not found "espn.ts"` / export errors.

- [ ] **Step 4: Write the minimal implementation**

Create `supabase/functions/sync-espn-live/espn.ts`:

```ts
// Fonctions pures pour la synchro ESPN. Aucune dépendance externe :
// testable avec `deno test`, importable par index.ts.

export function normalizeName(s: string): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // retire les accents
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function lastToken(s: string): string {
  const parts = normalizeName(s).split(' ').filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

export function surnameMatch(a: string, b: string): boolean {
  const la = lastToken(a), lb = lastToken(b)
  return la !== '' && la === lb
}

export function resolveSquadName(espnName: string, roster: string[]): string | null {
  const target = normalizeName(espnName)
  if (!target) return null
  // 1) égalité exacte normalisée
  for (const r of roster) if (normalizeName(r) === target) return r
  // 2) même nom de famille
  for (const r of roster) if (surnameMatch(espnName, r)) return r
  // 3) inclusion dans un sens ou l'autre
  for (const r of roster) {
    const nr = normalizeName(r)
    if (nr.includes(target) || target.includes(nr)) return r
  }
  return null
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `deno test --allow-net espn.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/sync-espn-live/espn.ts supabase/functions/sync-espn-live/espn.test.ts
git commit -m "feat(espn): name normalization and squad-name resolver"
```

---

### Task 3: ESPN summary parser (TDD)

**Files:**
- Modify: `supabase/functions/sync-espn-live/espn.ts`
- Test: `supabase/functions/sync-espn-live/espn.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `cleanMinute(displayValue: string | null | undefined): number`
  - `type GoalSide = 'home' | 'away'`
  - `interface EspnGoal { scorerName: string; side: GoalSide; minute: number; isOwnGoal: boolean }`
  - `interface ParsedSummary { status: 'upcoming' | 'live' | 'finished'; homeScore: number | null; awayScore: number | null; goals: EspnGoal[] }`
  - `parseSummary(summary: any): ParsedSummary` — reads `summary.header.competitions[0]`: competitors (`homeAway`, `id`, `score`) and `details[]` (keeps `scoringPlay === true`, excludes shootout via `period.number > 4` or `scoringPlay` entries flagged as shootout). Goal side from `detail.team.id` vs the home competitor id. `isOwnGoal` from `detail.ownGoal === true`.

- [ ] **Step 1: Write the failing test**

Append to `espn.test.ts`:

```ts
import { cleanMinute, parseSummary } from './espn.ts'

Deno.test('cleanMinute parses ESPN clock displays', () => {
  assertEquals(cleanMinute("45'"), 45)
  assertEquals(cleanMinute("45'+2'"), 47)
  assertEquals(cleanMinute("90'+3"), 93)
  assertEquals(cleanMinute(undefined), 0)
})

const SAMPLE_SUMMARY = {
  header: {
    competitions: [{
      status: { type: { state: 'post', completed: true } },
      competitors: [
        { id: 'H', homeAway: 'home', score: '2' },
        { id: 'A', homeAway: 'away', score: '1' },
      ],
      details: [
        { scoringPlay: true, ownGoal: false, team: { id: 'H' }, clock: { displayValue: "23'" },
          participants: [{ athlete: { shortName: 'K. Mbappé' } }], period: { number: 1 } },
        { scoringPlay: true, ownGoal: true, team: { id: 'H' }, clock: { displayValue: "55'" },
          participants: [{ athlete: { shortName: 'J. Doe' } }], period: { number: 2 } },
        { scoringPlay: true, ownGoal: false, team: { id: 'A' }, clock: { displayValue: "70'" },
          participants: [{ athlete: { shortName: 'Lautaro Martínez' } }], period: { number: 2 } },
        { scoringPlay: false, redCard: true, team: { id: 'A' }, clock: { displayValue: "80'" },
          participants: [{ athlete: { shortName: 'Someone' } }], period: { number: 2 } },
      ],
    }],
  },
}

Deno.test('parseSummary extracts status, score, and goals (own goal flagged, red card ignored)', () => {
  const p = parseSummary(SAMPLE_SUMMARY)
  assertEquals(p.status, 'finished')
  assertEquals(p.homeScore, 2)
  assertEquals(p.awayScore, 1)
  assertEquals(p.goals.length, 3)
  assertEquals(p.goals[0], { scorerName: 'K. Mbappé', side: 'home', minute: 23, isOwnGoal: false })
  assertEquals(p.goals[1].isOwnGoal, true)
  assertEquals(p.goals[2], { scorerName: 'Lautaro Martínez', side: 'away', minute: 70, isOwnGoal: false })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-net espn.test.ts`
Expected: FAIL — `cleanMinute`/`parseSummary` not exported.

- [ ] **Step 3: Write the implementation**

Append to `espn.ts`:

```ts
export function cleanMinute(displayValue: string | null | undefined): number {
  if (!displayValue) return 0
  const m = String(displayValue).match(/(\d+)(?:'?\+(\d+))?/)
  if (!m) return 0
  return parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) : 0)
}

export type GoalSide = 'home' | 'away'
export interface EspnGoal { scorerName: string; side: GoalSide; minute: number; isOwnGoal: boolean }
export interface ParsedSummary {
  status: 'upcoming' | 'live' | 'finished'
  homeScore: number | null
  awayScore: number | null
  goals: EspnGoal[]
}

export function parseSummary(summary: any): ParsedSummary {
  const comp = summary?.header?.competitions?.[0]
  const competitors: any[] = comp?.competitors ?? []
  const homeC = competitors.find((c) => c.homeAway === 'home') ?? competitors[0]
  const awayC = competitors.find((c) => c.homeAway === 'away') ?? competitors[1]

  const state = comp?.status?.type?.state
  const completed = comp?.status?.type?.completed === true
  const status: ParsedSummary['status'] =
    state === 'post' || completed ? 'finished' : state === 'in' ? 'live' : 'upcoming'

  const toScore = (c: any): number | null => {
    if (c?.score === undefined || c?.score === null || c?.score === '') return null
    const n = parseInt(String(c.score), 10)
    return Number.isNaN(n) ? null : n
  }

  const goals: EspnGoal[] = []
  for (const d of (comp?.details ?? [])) {
    if (!d?.scoringPlay) continue                 // ignore cartons, etc.
    if ((d?.period?.number ?? 0) > 4) continue    // ignore les tirs au but (séance = période 5)
    goals.push({
      scorerName: d?.participants?.[0]?.athlete?.shortName ?? '',
      side: d?.team?.id === homeC?.id ? 'home' : 'away',
      minute: cleanMinute(d?.clock?.displayValue),
      isOwnGoal: d?.ownGoal === true,
    })
  }
  goals.sort((a, b) => a.minute - b.minute)

  return { status, homeScore: toScore(homeC), awayScore: toScore(awayC), goals }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test --allow-net espn.test.ts`
Expected: PASS (all tests in file).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/sync-espn-live/espn.ts supabase/functions/sync-espn-live/espn.test.ts
git commit -m "feat(espn): summary parser for status, score, and goals"
```

---

### Task 4: `buildScorerResult` (TDD)

**Files:**
- Modify: `supabase/functions/sync-espn-live/espn.ts`
- Test: `supabase/functions/sync-espn-live/espn.test.ts`

**Interfaces:**
- Consumes: `EspnGoal`, `resolveSquadName` (Tasks 2-3).
- Produces:
  - `buildScorerResult(goals: EspnGoal[], homeRoster: string[], awayRoster: string[], finished: boolean): { result: string | null; unmatched: string[] }`
  - Rules: exclude own goals. Map each remaining goal to its side's roster via `resolveSquadName`; if unmatched, use the raw ESPN name **and** add it to `unmatched`. `result` = canonical names joined `, ` in minute order (goals already sorted), one per goal. If there are zero non-own-goal goals: `result = 'AUCUN_BUT'` when `finished`, else `null` (a scoreless match in progress is not final).

- [ ] **Step 1: Write the failing test**

Append to `espn.test.ts`:

```ts
import { buildScorerResult } from './espn.ts'
import type { EspnGoal } from './espn.ts'

const HOME = ['Kylian Mbappé', 'Antoine Griezmann']
const AWAY = ['Lautaro Martínez', 'Julián Álvarez']

Deno.test('buildScorerResult maps names, excludes own goals, orders by minute', () => {
  const goals: EspnGoal[] = [
    { scorerName: 'K. Mbappé', side: 'home', minute: 23, isOwnGoal: false },
    { scorerName: 'J. Doe', side: 'home', minute: 55, isOwnGoal: true },   // own goal → excluded
    { scorerName: 'Martinez', side: 'away', minute: 70, isOwnGoal: false },
  ]
  const r = buildScorerResult(goals, HOME, AWAY, true)
  assertEquals(r.result, 'Kylian Mbappé, Lautaro Martínez')
  assertEquals(r.unmatched, [])
})

Deno.test('buildScorerResult repeats a multi-goal scorer and flags unmatched', () => {
  const goals: EspnGoal[] = [
    { scorerName: 'K. Mbappé', side: 'home', minute: 10, isOwnGoal: false },
    { scorerName: 'K. Mbappé', side: 'home', minute: 80, isOwnGoal: false },
    { scorerName: 'Mystery Sub', side: 'away', minute: 90, isOwnGoal: false },
  ]
  const r = buildScorerResult(goals, HOME, AWAY, true)
  assertEquals(r.result, 'Kylian Mbappé, Kylian Mbappé, Mystery Sub')
  assertEquals(r.unmatched, ['Mystery Sub'])
})

Deno.test('buildScorerResult: finished scoreless → AUCUN_BUT; in-progress → null', () => {
  assertEquals(buildScorerResult([], HOME, AWAY, true).result, 'AUCUN_BUT')
  assertEquals(buildScorerResult([], HOME, AWAY, false).result, null)
  // only own goals, finished → still AUCUN_BUT (no qualifying scorer)
  const og: EspnGoal[] = [{ scorerName: 'X', side: 'home', minute: 30, isOwnGoal: true }]
  assertEquals(buildScorerResult(og, HOME, AWAY, true).result, 'AUCUN_BUT')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-net espn.test.ts`
Expected: FAIL — `buildScorerResult` not exported.

- [ ] **Step 3: Write the implementation**

Append to `espn.ts`:

```ts
export function buildScorerResult(
  goals: EspnGoal[],
  homeRoster: string[],
  awayRoster: string[],
  finished: boolean,
): { result: string | null; unmatched: string[] } {
  const unmatched: string[] = []
  const names: string[] = []

  for (const g of goals) {
    if (g.isOwnGoal) continue
    const roster = g.side === 'home' ? homeRoster : awayRoster
    const canonical = resolveSquadName(g.scorerName, roster)
    if (canonical) {
      names.push(canonical)
    } else {
      names.push(g.scorerName)        // on garde le nom brut pour ne pas fausser le compte
      unmatched.push(g.scorerName)
    }
  }

  if (names.length === 0) {
    return { result: finished ? 'AUCUN_BUT' : null, unmatched }
  }
  return { result: names.join(', '), unmatched }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test --allow-net espn.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/sync-espn-live/espn.ts supabase/functions/sync-espn-live/espn.test.ts
git commit -m "feat(espn): build scorer_result string from mapped goals"
```

---

### Task 5: ESPN event resolver + kickoff helpers (TDD)

**Files:**
- Modify: `supabase/functions/sync-espn-live/espn.ts`
- Test: `supabase/functions/sync-espn-live/espn.test.ts`

**Interfaces:**
- Consumes: `normalizeName` (Task 2).
- Produces:
  - `const FR_TO_EN: Record<string, string[]>` — French→English team-name map (copied from `import-fixtures/index.ts`).
  - `enNames(frName: string): string[]`
  - `kickoffMs(day: string, matchTime: string): number | null` — copied from `match-reminders/index.ts` (Paris UTC+2).
  - `espnDatesToTry(kickoffMs: number): string[]` — `[YYYYMMDD(utc), YYYYMMDD(utc - 1 day)]` deduped (US calendar date can be the UTC date minus one).
  - `findEventId(scoreboard: any, frHome: string, frAway: string): string | null` — scans `scoreboard.events[]`, matches both teams' English names against `competition.competitors[].team` (`displayName`/`name`/`shortDisplayName`) by normalized substring, returns `event.id`.

- [ ] **Step 1: Write the failing test**

Append to `espn.test.ts`:

```ts
import { enNames, kickoffMs, espnDatesToTry, findEventId } from './espn.ts'

Deno.test('enNames maps French team names to English candidates', () => {
  assertEquals(enNames('Allemagne'), ['Germany'])
  assertEquals(enNames('Espagne'), ['Spain'])
  assertEquals(enNames('Pays inconnu'), ['Pays inconnu']) // fallback to itself
})

Deno.test('kickoffMs converts Paris-local day/time to UTC epoch ms', () => {
  // 22 juin 2026 23:00 CEST = 21:00 UTC
  assertEquals(kickoffMs('22 juin', '23:00'), Date.UTC(2026, 5, 22, 21, 0))
  assertEquals(kickoffMs('', ''), null)
})

Deno.test('espnDatesToTry returns the UTC date and the day before', () => {
  // 2026-06-25 01:00 UTC → try 20260625 and 20260624
  const ko = Date.UTC(2026, 5, 25, 1, 0)
  assertEquals(espnDatesToTry(ko), ['20260625', '20260624'])
})

Deno.test('findEventId matches both teams against ESPN scoreboard', () => {
  const scoreboard = {
    events: [
      { id: '111', competitions: [{ competitors: [
        { team: { displayName: 'France' } }, { team: { displayName: 'Spain' } },
      ] }] },
      { id: '222', competitions: [{ competitors: [
        { team: { displayName: 'Germany' } }, { team: { displayName: 'Brazil' } },
      ] }] },
    ],
  }
  assertEquals(findEventId(scoreboard, 'Allemagne', 'Brésil'), '222')
  assertEquals(findEventId(scoreboard, 'France', 'Espagne'), '111')
  assertEquals(findEventId(scoreboard, 'France', 'Allemagne'), null) // not a real pairing
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno test --allow-net espn.test.ts`
Expected: FAIL — new exports missing.

- [ ] **Step 3: Write the implementation**

Append to `espn.ts`:

```ts
// Noms FR → EN (copié de import-fixtures/index.ts pour rester autonome).
export const FR_TO_EN: Record<string, string[]> = {
  'Allemagne': ['Germany'], 'France': ['France'], 'Brésil': ['Brazil'],
  'Argentine': ['Argentina'], 'Espagne': ['Spain'], 'Pays-Bas': ['Netherlands'],
  'Portugal': ['Portugal'], 'Angleterre': ['England'],
  'États-Unis': ['USA', 'United States'], 'Mexique': ['Mexico'],
  'Canada': ['Canada'], 'Japon': ['Japan'], 'Corée du Sud': ['South Korea'],
  'Australie': ['Australia'], 'Maroc': ['Morocco'], 'Sénégal': ['Senegal'],
  "Côte d'Ivoire": ['Ivory Coast', "Cote d'Ivoire"],
  'Nigeria': ['Nigeria'], 'Cameroun': ['Cameroon'], 'Égypte': ['Egypt'],
  'Afrique du Sud': ['South Africa'], 'Belgique': ['Belgium'],
  'Croatie': ['Croatia'], 'Suisse': ['Switzerland'], 'Danemark': ['Denmark'],
  'Suède': ['Sweden'], 'Autriche': ['Austria'],
  'Turquie': ['Turkey', 'Türkiye'], 'Pologne': ['Poland'],
  'Hongrie': ['Hungary'], 'Slovaquie': ['Slovakia'], 'Roumanie': ['Romania'],
  'Serbie': ['Serbia'], 'Uruguay': ['Uruguay'], 'Colombie': ['Colombia'],
  'Équateur': ['Ecuador'], 'Pérou': ['Peru'], 'Chili': ['Chile'],
  'Paraguay': ['Paraguay'], 'Bolivie': ['Bolivia'], 'Venezuela': ['Venezuela'],
  'Costa Rica': ['Costa Rica'], 'Honduras': ['Honduras'],
  'Jamaïque': ['Jamaica'], 'Panama': ['Panama'],
  'Arabie Saoudite': ['Saudi Arabia'], 'Iran': ['Iran'], 'Irak': ['Iraq'],
  'Jordanie': ['Jordan'], 'Chine': ['China'], 'Indonésie': ['Indonesia'],
  'Thaïlande': ['Thailand'], 'Philippines': ['Philippines'],
  'Nouvelle-Zélande': ['New Zealand'], 'Ouzbékistan': ['Uzbekistan'],
  'Tunisie': ['Tunisia'], 'Ghana': ['Ghana'], 'Mali': ['Mali'],
  'Guinée': ['Guinea'], 'Curaçao': ['Curaçao', 'Curacao'],
  'Tanzanie': ['Tanzania'], 'Zimbabwe': ['Zimbabwe'],
  'Albanie': ['Albania'], 'Slovénie': ['Slovenia'], 'Grèce': ['Greece'],
  'Tchéquie': ['Czech Republic', 'Czechia'], 'Ukraine': ['Ukraine'],
  'Écosse': ['Scotland'], 'Irlande': ['Ireland'], 'Géorgie': ['Georgia'],
}

export function enNames(frName: string): string[] {
  return FR_TO_EN[frName] || [frName]
}

const PARIS_OFFSET_MS = 2 * 60 * 60 * 1000 // CEST = UTC+2
const MONTHS: Record<string, number> = {
  janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11,
  décembre: 12, decembre: 12,
}

export function kickoffMs(day: string, matchTime: string): number | null {
  if (!day || !matchTime) return null
  const dm = day.trim().match(/(\d+)\s+(\S+)/)
  if (!dm) return null
  const dayNum = parseInt(dm[1], 10)
  const mon = MONTHS[dm[2].toLowerCase()]
  if (!mon) return null
  const tm = matchTime.match(/(\d{1,2})[:h](\d{2})/)
  if (!tm) return null
  return Date.UTC(2026, mon - 1, dayNum, parseInt(tm[1], 10), parseInt(tm[2], 10)) - PARIS_OFFSET_MS
}

function ymd(ms: number): string {
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

export function espnDatesToTry(kickoffMs: number): string[] {
  const a = ymd(kickoffMs)
  const b = ymd(kickoffMs - 24 * 60 * 60 * 1000)
  return a === b ? [a] : [a, b]
}

export function findEventId(scoreboard: any, frHome: string, frAway: string): string | null {
  const homeCands = enNames(frHome).map(normalizeName)
  const awayCands = enNames(frAway).map(normalizeName)
  const hit = (espnTeam: string, cands: string[]) => {
    const n = normalizeName(espnTeam)
    return cands.some((c) => n.includes(c) || c.includes(n))
  }
  for (const ev of (scoreboard?.events ?? [])) {
    const comps: any[] = ev?.competitions?.[0]?.competitors ?? []
    const names = comps.map((c) => c?.team?.displayName || c?.team?.name || c?.team?.shortDisplayName || '')
    const homeOk = names.some((nm) => hit(nm, homeCands))
    const awayOk = names.some((nm) => hit(nm, awayCands))
    if (homeOk && awayOk) return String(ev.id)
  }
  return null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test --allow-net espn.test.ts`
Expected: PASS (all file tests).

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/sync-espn-live/espn.ts supabase/functions/sync-espn-live/espn.test.ts
git commit -m "feat(espn): event resolver, FR->EN map, and kickoff helpers"
```

---

### Task 6: `sync-espn-live` edge function (orchestration)

**Files:**
- Create: `supabase/functions/sync-espn-live/index.ts`

**Interfaces:**
- Consumes: everything exported from `espn.ts` (Tasks 2-5).
- Produces: a deployed edge function `sync-espn-live` (GET/POST, no body) that updates `matches` and pushes admin alerts. This is integration glue — verified manually, not unit-tested.

- [ ] **Step 1: Write the function**

Create `supabase/functions/sync-espn-live/index.ts`:

```ts
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  kickoffMs, espnDatesToTry, findEventId, parseSummary, buildScorerResult,
} from './espn.ts'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
}
const SB = 'https://site.api.espn.com/apis/site/v2/sports/soccer/FIFA.WORLD'
const WINDOW_BEFORE_MS = 5 * 60 * 1000        // tolère un coup d'envoi proche
const WINDOW_AFTER_MS = 5 * 60 * 60 * 1000    // 90'+prolong.+t.a.b.+marge

async function espnJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // 1) Matchs candidats : non terminés OU sans buteur enregistré.
  const { data: rows } = await sb
    .from('matches')
    .select('id, home, away, day, match_time, status, score_home, score_away, scorer_result, espn_event_id')
    .or('status.neq.finished,scorer_result.is.null')

  const now = Date.now()
  const candidates = (rows ?? []).filter((m: any) => {
    const ko = kickoffMs(m.day, m.match_time)
    if (ko == null) return false
    return ko <= now + WINDOW_BEFORE_MS && ko >= now - WINDOW_AFTER_MS
  })

  if (candidates.length === 0) {
    return new Response(JSON.stringify({ ok: true, checked: 0 }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  const allUnmatched: { match: string; name: string }[] = []
  let updated = 0

  for (const m of candidates) {
    // 2) Résoudre l'event ESPN (une fois), via le scoreboard du/des jour(s).
    let eventId: string | null = m.espn_event_id
    if (!eventId) {
      const ko = kickoffMs(m.day, m.match_time)!
      for (const d of espnDatesToTry(ko)) {
        const sbd = await espnJson(`${SB}/scoreboard?dates=${d}`)
        eventId = sbd ? findEventId(sbd, m.home, m.away) : null
        if (eventId) break
      }
      if (!eventId) continue // pas trouvé ce tour-ci : on réessaiera
      await sb.from('matches').update({ espn_event_id: eventId }).eq('id', m.id)
    }

    // 3) Résumé ESPN.
    const summary = await espnJson(`${SB}/summary?event=${eventId}`)
    if (!summary) continue
    const parsed = parseSummary(summary)
    const finished = parsed.status === 'finished'

    // 4) Rosters par équipe (noms FR identiques à matches.home/away).
    const { data: squadRows } = await sb
      .from('squads').select('player_name, team_name')
      .in('team_name', [m.home, m.away])
    const homeRoster = (squadRows ?? []).filter((s: any) => s.team_name === m.home).map((s: any) => s.player_name)
    const awayRoster = (squadRows ?? []).filter((s: any) => s.team_name === m.away).map((s: any) => s.player_name)

    const { result, unmatched } = buildScorerResult(parsed.goals, homeRoster, awayRoster, finished)

    // 5) Écriture. Score/statut : toujours (le trigger gèle les matchs déjà
    //    terminés côté DB). scorer_result : on n'écrase jamais un match déjà
    //    terminé dont le buteur est déjà saisi (correction admin protégée).
    const update: Record<string, any> = {}
    if (parsed.homeScore !== null) update.score_home = parsed.homeScore
    if (parsed.awayScore !== null) update.score_away = parsed.awayScore
    if (parsed.status !== 'upcoming') update.status = parsed.status

    const alreadyFinalised = m.status === 'finished' && m.scorer_result != null
    if (result !== null && !alreadyFinalised) update.scorer_result = result

    if (Object.keys(update).length > 0) {
      await sb.from('matches').update(update).eq('id', m.id)
      updated++
    }

    for (const name of unmatched) allUnmatched.push({ match: `${m.home} vs ${m.away}`, name })
  }

  // 6) Alerte admin pour les buteurs non reconnus.
  if (allUnmatched.length > 0) {
    const { data: admins } = await sb.from('players').select('id').eq('is_admin', true)
    const adminIds = (admins ?? []).map((a: any) => a.id)
    if (adminIds.length > 0) {
      const notifications = allUnmatched.flatMap((u) =>
        adminIds.map((id: string) => ({
          player_id: id,
          title: '⚠️ Buteur non reconnu',
          body: `"${u.name}" — ${u.match}. À corriger dans l'admin.`,
        })),
      )
      await sb.functions.invoke('send-push', { body: { title: '⚠️ Buteur non reconnu', notifications } })
    }
  }

  return new Response(JSON.stringify({ ok: true, checked: candidates.length, updated, unmatched: allUnmatched }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})
```

- [ ] **Step 2: Deploy the function**

Run: `npx supabase functions deploy sync-espn-live --project-ref godcigantcuuwnwerxjc`
Expected: deploy succeeds and the function appears in Supabase → Edge Functions.
(Ensure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are present in the function's env — they already are for `match-reminders`/`send-push`.)

- [ ] **Step 3: Manually verify against a finished match**

Pick a finished WC match whose scorers you know. Temporarily set its row's `scorer_result` to NULL and `espn_event_id` to NULL in the SQL editor, then invoke:
```bash
curl -X POST "https://godcigantcuuwnwerxjc.supabase.co/functions/v1/sync-espn-live" \
  -H "Authorization: Bearer <ANON_OR_SERVICE_KEY>"
```
Then check the row:
```sql
select home, away, score_home, score_away, status, scorer_result, espn_event_id
from matches where id = <THAT_MATCH_ID>;
```
Expected: `espn_event_id` filled, `scorer_result` lists the correct scorers as canonical squad names (or `AUCUN_BUT`), score/status correct.

- [ ] **Step 4: Verify the unmatched-name path**

Pick a finished match, blank its `scorer_result`, and temporarily remove one real scorer from that team's `squads` rows (or rename it). Invoke the function again. Expected: the JSON response `unmatched` array contains the name, the admin device(s) receive the "⚠️ Buteur non reconnu" push, and `scorer_result` still contains the raw name. Restore the squad row afterwards.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/sync-espn-live/index.ts
git commit -m "feat(espn): sync-espn-live edge function (live score + scorers + admin alert)"
```

---

### Task 7: Schedule the function with pg_cron

**Files:**
- Create: `supabase/migrations/schedule_sync_espn_live.sql`

**Interfaces:**
- Consumes: deployed `sync-espn-live` (Task 6).
- Produces: a pg_cron job `sync-espn-live` calling the function every 2 min in-window.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/schedule_sync_espn_live.sql` (reuse the exact anon bearer token from `schedule_match_reminders.sql`):

```sql
-- Appelle la fonction "sync-espn-live" toutes les 2 minutes, uniquement
-- pendant la fenêtre des matchs : 16:00–07:59 UTC = 18:00–09:59 CEST.
-- (Coup d'envoi le plus tôt 18:00 CEST ; un 8e de finale tardif peut finir
--  vers 09:00 CEST avec prolongations + t.a.b.)
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule(jobid) from cron.job where jobname = 'sync-espn-live';

select cron.schedule(
  'sync-espn-live',
  '*/2 16-23,0-7 * * *',
  $$
  select net.http_post(
    url     := 'https://godcigantcuuwnwerxjc.supabase.co/functions/v1/sync-espn-live',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdvZGNpZ2FudGN1dXdud2VyeGpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYxNjU5MzYsImV4cCI6MjA5MTc0MTkzNn0.6udFhN0OhzWOGhLoLrD3q2qoS9zey9iHQVCUsdkBKpo'
    ),
    body    := '{}'::jsonb
  );
  $$
);
```

- [ ] **Step 2: Apply it in the Supabase SQL editor**

Paste and Run.

- [ ] **Step 3: Verify the job is scheduled**

Run:
```sql
select jobname, schedule, active from cron.job where jobname = 'sync-espn-live';
```
Expected: one row, schedule `*/2 16-23,0-7 * * *`, active `true`.

- [ ] **Step 4: Confirm it runs (during the window)**

After a couple of minutes inside the window, run:
```sql
select status, return_message, start_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'sync-espn-live')
order by start_time desc limit 3;
```
Expected: recent rows with `status = 'succeeded'`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/schedule_sync_espn_live.sql
git commit -m "feat(db): schedule sync-espn-live every 2 min during match window"
```

---

### Task 8: End-to-end verification with a real live match

**Files:** none (verification only).

- [ ] **Step 1: During a live WC match, watch a match row**

In the SQL editor, every few minutes:
```sql
select home, away, score_home, score_away, status, scorer_result, espn_event_id
from matches where status in ('live','upcoming') and espn_event_id is not null
order by day, match_time;
```
Expected: score and `scorer_result` update within ~2 min of goals; `status` flips to `finished` shortly after full time.

- [ ] **Step 2: Confirm a 🔥 Buteur bet settles**

After a match finishes, open the app and confirm a player who picked a correct scorer shows their Buteur points, and the leaderboard reflects it (settlement reads `scorer_result`; `index.html:7732-7736`).

- [ ] **Step 3: Confirm manual override is preserved**

For a finished match, change `scorer_result` by hand in the admin panel, wait for the next cron tick, and re-check the row. Expected: your value is unchanged (the function skips finished matches that already have a `scorer_result`).

- [ ] **Step 4: Final commit (docs/notes if any)**

```bash
git add -A
git commit -m "docs(espn): notes from end-to-end scorer sync verification" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- ESPN as scorer source, FIFA.WORLD endpoints → Tasks 3, 6. ✅
- New `espn_event_id` column + caching → Tasks 1, 6. ✅
- Match→ESPN-event resolution via scoreboard + FR_TO_EN → Task 5, used in Task 6. ✅
- Live score + status + scorers from summary → Tasks 3, 6. ✅
- Name mapping ESPN→squad with surname + fallback → Tasks 2, 4. ✅
- `scorer_result` format (per-goal, ordered, AUCUN_BUT) → Task 4. ✅
- Only-when-empty for finished matches → Task 6 (`alreadyFinalised`). ✅
- Own goals & shootout excluded → Tasks 3 (period>4), 4 (isOwnGoal). ✅
- Admin push on unmatched (is_admin players, targeted send-push) → Task 6. ✅
- pg_cron every 2 min, 16:00–07:59 UTC window → Task 7. ✅
- API-Football / import-fixtures untouched, MOTM stays manual → not modified (by omission). ✅

**Placeholder scan:** No TBD/TODO; all code blocks complete; verification steps give exact SQL/commands. The only human-supplied literal is `<THAT_MATCH_ID>` / `<ANON_OR_SERVICE_KEY>` in manual verification, which is intentional.

**Type consistency:** `EspnGoal`, `ParsedSummary`, `GoalSide` defined in Task 3 and consumed unchanged in Tasks 4 & 6. `buildScorerResult` returns `{ result, unmatched }` used exactly that way in Task 6. `findEventId`, `kickoffMs`, `espnDatesToTry`, `parseSummary` signatures match their call sites in `index.ts`.
