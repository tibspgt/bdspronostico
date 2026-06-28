// sync-espn-live — fichier unique, autonome (copier-coller dans le dashboard Supabase).
// Récupère score, statut et buteurs d'un match via l'API publique ESPN, mappe les
// buteurs sur l'effectif (squads) et écrit matches.scorer_result. Les fonctions
// utilitaires sont exportées et testées par espn.test.ts ; le serveur n'est démarré
// que lorsque ce fichier est le point d'entrée (import.meta.main), pas pendant les tests.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─────────────────────────────────────────────────────────────────────────────
//  Fonctions pures (mapping des noms, parsing ESPN, construction du résultat)
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeName(s: string): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // retire les accents
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

// Suffixes "Junior"/"Senior" : ESPN écrit le mot complet ("Vinícius Júnior"),
// les effectifs souvent l'abréviation ("Vinicius JR"). On les ramène à une forme
// canonique pour que le mapping fonctionne dans les deux sens.
const NAME_SUFFIX: Record<string, string> = {
  jr: 'junior', jnr: 'junior', junior: 'junior',
  sr: 'senior', snr: 'senior', senior: 'senior',
}

// Tokens normalisés + abréviations de suffixe canonicalisées ("jr." → "junior").
function canonicalTokens(s: string): string[] {
  return normalizeName(s).split(' ').filter(Boolean).map((t) => {
    const bare = t.replace(/\.+$/, '') // retire un point final éventuel ("jr." → "jr")
    return NAME_SUFFIX[bare] ?? bare
  })
}

function canonicalName(s: string): string {
  return canonicalTokens(s).join(' ')
}

function lastToken(s: string): string {
  const parts = canonicalTokens(s)
  return parts.length ? parts[parts.length - 1] : ''
}

export function surnameMatch(a: string, b: string): boolean {
  const la = lastToken(a), lb = lastToken(b)
  return la !== '' && la === lb
}

export function resolveSquadName(espnName: string, roster: string[]): string | null {
  const target = canonicalName(espnName)
  if (!target) return null
  // 1) égalité exacte (suffixes Jr/Júnior canonicalisés)
  for (const r of roster) if (canonicalName(r) === target) return r
  // 2) même nom de famille
  for (const r of roster) if (surnameMatch(espnName, r)) return r
  // 3) inclusion dans un sens ou l'autre
  for (const r of roster) {
    const nr = canonicalName(r)
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
  statusDescription: string   // ex. "Halftime", "Second Half" (brut ESPN)
  displayClock: string        // ex. "67'", "45'+3'" (brut ESPN)
  homeScore: number | null
  awayScore: number | null
  goals: EspnGoal[]
  penaltyWinner: GoalSide | null  // vainqueur de la séance de tirs au but ('home'/'away'), sinon null
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

  const statusDescription = comp?.status?.type?.description ?? ''
  const displayClock = comp?.status?.displayClock ?? ''

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

  // Vainqueur aux tirs au but : un match à élimination directe à égalité après
  // prolongation se décide aux pénos. ESPN marque le qualifié via le booléen
  // `winner` du competitor ; à défaut on compare `shootoutScore`.
  let penaltyWinner: GoalSide | null = null
  if (homeC?.winner === true) penaltyWinner = 'home'
  else if (awayC?.winner === true) penaltyWinner = 'away'
  else {
    const hs = parseInt(String(homeC?.shootoutScore ?? ''), 10)
    const as = parseInt(String(awayC?.shootoutScore ?? ''), 10)
    if (!Number.isNaN(hs) && !Number.isNaN(as) && hs !== as) penaltyWinner = hs > as ? 'home' : 'away'
  }

  return { status, statusDescription, displayClock, homeScore: toScore(homeC), awayScore: toScore(awayC), goals, penaltyWinner }
}

// Libellé "live" en français pour l'app : "Mi-temps", "T.A.B.", ou la minute ESPN.
export function frLiveLabel(description: string, displayClock: string): string {
  const d = (description ?? '').toLowerCase()
  if (d === 'halftime' || d.includes('half-time') || d.includes('mi-temps')) return 'Mi-temps'
  if (d.includes('penalt')) return 'T.A.B.' // séance de tirs au but
  return (displayClock ?? '').trim()
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

// Noms FR → EN (copié de import-fixtures pour rester autonome).
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
  'RD Congo': ['Congo DR', 'DR Congo'], 'Qatar': ['Qatar'], 'Haïti': ['Haiti'],
  'Bosnie-Herzégovine': ['Bosnia-Herzegovina', 'Bosnia and Herzegovina'],
  'Algérie': ['Algeria'], 'Cap-Vert': ['Cape Verde', 'Cabo Verde'], 'Norvège': ['Norway'],
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
  return [a, b]
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

// ─────────────────────────────────────────────────────────────────────────────
//  Serveur (synchro live)
// ─────────────────────────────────────────────────────────────────────────────

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

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // 1) Matchs candidats : non terminés OU sans buteur enregistré OU dont le
  //    rappel "homme du match" n'a pas encore été envoyé aux admins.
  const { data: rows } = await sb
    .from('matches')
    .select('id, home, away, day, match_time, status, score_home, score_away, scorer_result, espn_event_id, motm_result, motm_notified_at, penalty_winner')
    .or('status.neq.finished,scorer_result.is.null,motm_notified_at.is.null')

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
  const motmReminders: { match: string }[] = []
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

    // Détail live ("Mi-temps", "67'") tant que le match est en cours ; effacé à la fin.
    if (parsed.status === 'live') update.live_detail = frLiveLabel(parsed.statusDescription, parsed.displayClock)
    else if (parsed.status === 'finished') update.live_detail = null

    const alreadyFinalised = m.status === 'finished' && m.scorer_result != null
    if (result !== null && !alreadyFinalised) update.scorer_result = result

    // Vainqueur aux pénos : on l'inscrit dès qu'un match terminé est à égalité
    // dans le score (une vraie séance a donc eu lieu), sans écraser une éventuelle
    // correction admin déjà saisie.
    if (finished && parsed.homeScore !== null && parsed.homeScore === parsed.awayScore
        && parsed.penaltyWinner && m.penalty_winner == null) {
      update.penalty_winner = parsed.penaltyWinner
    }

    // À la fin du match : on marque le rappel "homme du match" comme traité dès
    // que le match est terminé — sinon, si l'admin a déjà choisi le MOTM, le
    // champ resterait null et le match reviendrait indéfiniment dans les
    // candidats (re-synchro + re-notification à chaque passage). On ne notifie
    // les admins que si le MOTM n'est pas encore saisi et que l'effectif existe.
    if (finished && !m.motm_notified_at) {
      update.motm_notified_at = new Date().toISOString()
      if (!m.motm_result && (homeRoster.length || awayRoster.length)) motmReminders.push({ match: `${m.home} vs ${m.away}` })
    }

    if (Object.keys(update).length > 0) {
      await sb.from('matches').update(update).eq('id', m.id)
      updated++
    }

    // Alerte "buteur non reconnu" : uniquement au moment où l'on écrit réellement
    // scorer_result (pas à chaque passage sur un match déjà finalisé), pour ne pas
    // spammer les admins toutes les 5 min tant qu'une correction n'est pas faite.
    if (finished && !alreadyFinalised) for (const name of unmatched) allUnmatched.push({ match: `${m.home} vs ${m.away}`, name })
  }

  // 6) Notifications admin : buteurs non reconnus + rappel "homme du match".
  if (allUnmatched.length > 0 || motmReminders.length > 0) {
    const { data: admins } = await sb.from('players').select('id').eq('is_admin', true)
    const adminIds = (admins ?? []).map((a: any) => a.id)
    if (adminIds.length > 0) {
      const notifications = [
        ...allUnmatched.flatMap((u) =>
          adminIds.map((id: string) => ({
            player_id: id,
            title: '⚠️ Buteur non reconnu',
            body: `"${u.name}" — ${u.match}. À corriger dans l'admin.`,
          })),
        ),
        ...motmReminders.flatMap((r) =>
          adminIds.map((id: string) => ({
            player_id: id,
            title: '⭐ Homme du match',
            body: `Match terminé : ${r.match}. Ajoute l'homme du match dans l'admin.`,
          })),
        ),
      ]
      await sb.functions.invoke('send-push', { body: { title: '⚽ CDM 2026', notifications } })
    }
  }

  return new Response(JSON.stringify({ ok: true, checked: candidates.length, updated, unmatched: allUnmatched, motmReminders: motmReminders.length }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// Démarre le serveur uniquement comme point d'entrée (pas pendant `deno test`).
if (import.meta.main) {
  Deno.serve(handleRequest)
}
