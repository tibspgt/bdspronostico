import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { normalizeName, surnameMatch, resolveSquadName } from './index.ts'

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

Deno.test('resolveSquadName bridges Jr/Júnior abbreviations (squad "Vinicius JR" ↔ ESPN "Vinícius Júnior")', () => {
  const roster = ['Vinicius JR', 'Matheus CUNHA', 'Raphinha']
  // full name from ESPN, abbreviated suffix in squad → tier-1 exact after canonicalization
  assertEquals(resolveSquadName('Vinícius Júnior', roster), 'Vinicius JR')
  // abbreviated first name from ESPN → tier-2 surname after canonicalization
  assertEquals(resolveSquadName('V. Júnior', roster), 'Vinicius JR')
  // reverse direction (Jr. with trailing dot) also canonicalizes
  assertEquals(surnameMatch('Vinícius Júnior', 'Vinicius Jr.'), true)
})

Deno.test('resolveSquadName falls back to substring match (tier 3) when exact and surname fail', () => {
  // 'Tchouameni' normalizes to 'tchouameni'; roster has 'Aurelien Tchouameni' → substring match
  // ESPN sends only the shortened version; it doesn't match exact ('aurelien tchouameni' ≠ 'tchouameni')
  // and surnameMatch won't fire because last token of 'Tchouameni' IS 'tchouameni' which equals
  // last token of 'Aurélien Tchouaméni' → actually that would be tier 2. Use a case where ESPN
  // sends a multi-word name that is a strict substring of the roster name.
  const roster2 = ['João Pedro Cavaco Silva']
  // ESPN name 'Pedro Cavaco' is a substring of normalized roster name, but not exact and not surname-match
  assertEquals(resolveSquadName('Pedro Cavaco', roster2), 'João Pedro Cavaco Silva')
})

import { cleanMinute, parseSummary, frLiveLabel } from './index.ts'

Deno.test('frLiveLabel: halftime localized to French, otherwise the live clock', () => {
  assertEquals(frLiveLabel('Halftime', "45'+3'"), 'Mi-temps')
  assertEquals(frLiveLabel('Second Half', "67'"), "67'")
  assertEquals(frLiveLabel('First Half', "23'"), "23'")
  assertEquals(frLiveLabel('Penalties', ''), 'T.A.B.')
  assertEquals(frLiveLabel('', "90'+2'"), "90'+2'")
})

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

Deno.test('parseSummary excludes penalty-shootout goals (period 5)', () => {
  const summaryWithShootout = {
    header: {
      competitions: [{
        status: { type: { state: 'post', completed: true } },
        competitors: [
          { id: 'H', homeAway: 'home', score: '4' },
          { id: 'A', homeAway: 'away', score: '3' },
        ],
        details: [
          { scoringPlay: true, ownGoal: false, team: { id: 'H' }, clock: { displayValue: "34'" },
            participants: [{ athlete: { shortName: 'K. Mbappé' } }], period: { number: 1 } },
          { scoringPlay: true, ownGoal: false, team: { id: 'A' }, clock: { displayValue: "1'" },
            participants: [{ athlete: { shortName: 'Penalty Scorer' } }], period: { number: 5 } },
        ],
      }],
    },
  }
  const p = parseSummary(summaryWithShootout)
  assertEquals(p.goals.length, 1)
  assertEquals(p.goals[0], { scorerName: 'K. Mbappé', side: 'home', minute: 34, isOwnGoal: false })
})

function shootoutSummary(homeC: any, awayC: any) {
  return { header: { competitions: [{ status: { type: { state: 'post', completed: true } },
    competitors: [{ id: 'H', homeAway: 'home', ...homeC }, { id: 'A', homeAway: 'away', ...awayC }], details: [] }] } }
}

Deno.test('parseSummary: penaltyWinner from ESPN winner flag (home)', () => {
  const p = parseSummary(shootoutSummary({ score: '1', winner: true }, { score: '1', winner: false }))
  assertEquals(p.penaltyWinner, 'home')
})

Deno.test('parseSummary: penaltyWinner from ESPN winner flag (away)', () => {
  const p = parseSummary(shootoutSummary({ score: '2', winner: false }, { score: '2', winner: true }))
  assertEquals(p.penaltyWinner, 'away')
})

Deno.test('parseSummary: penaltyWinner falls back to shootoutScore when no winner flag', () => {
  const p = parseSummary(shootoutSummary({ score: '2', shootoutScore: '4' }, { score: '2', shootoutScore: '5' }))
  assertEquals(p.penaltyWinner, 'away')
})

Deno.test('parseSummary: penaltyWinner null for a decisive result (no shootout)', () => {
  const p = parseSummary(shootoutSummary({ score: '2' }, { score: '1' }))
  assertEquals(p.penaltyWinner, null)
})

import { buildScorerResult } from './index.ts'
import type { EspnGoal } from './index.ts'

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

import { enNames, kickoffMs, espnDatesToTry, findEventId } from './index.ts'

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
