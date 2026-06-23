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

    if (finished) for (const name of unmatched) allUnmatched.push({ match: `${m.home} vs ${m.away}`, name })
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
