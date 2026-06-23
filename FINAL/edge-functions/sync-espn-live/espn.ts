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
