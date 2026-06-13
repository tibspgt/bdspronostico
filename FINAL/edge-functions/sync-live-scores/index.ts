import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  // Le frontend envoie la liste des fixture_ids à synchroniser
  const body = await req.json().catch(() => ({}))
  const fixtureIds: number[] = body.fixture_ids || []

  if (!fixtureIds.length) {
    return new Response(JSON.stringify({ message: 'Aucun match à synchroniser', updated: 0 }), {
      headers: { ...CORS, 'Content-Type': 'application/json' }
    })
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )
  const apiKey = Deno.env.get('FOOTBALL_API_KEY')!

  // Trouver les IDs internes de nos matchs
  const { data: dbMatches, error: dbErr } = await supabase
    .from('matches')
    .select('id, api_fixture_id')
    .in('api_fixture_id', fixtureIds)

  if (dbErr || !dbMatches?.length) {
    return new Response(JSON.stringify({ error: dbErr?.message || 'Matchs introuvables', updated: 0 }), {
      headers: { ...CORS, 'Content-Type': 'application/json' }, status: 500
    })
  }

  // Un seul appel API pour tous les matchs (économie de quota)
  const ids = fixtureIds.join('-')
  const res = await fetch(`https://v3.football.api-sports.io/fixtures?ids=${ids}`, {
    headers: {
      'x-rapidapi-key': apiKey,
      'x-rapidapi-host': 'v3.football.api-sports.io'
    }
  })
  const apiData = await res.json()

  if (!apiData.response) {
    return new Response(JSON.stringify({ error: 'Erreur API-Football', details: apiData }), {
      headers: { ...CORS, 'Content-Type': 'application/json' }, status: 500
    })
  }

  // Statuts API-Football → statuts de notre DB
  const LIVE_STATUSES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE'])
  const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN'])

  let updated = 0
  for (const fixture of apiData.response) {
    const dbMatch = dbMatches.find(m => m.api_fixture_id === fixture.fixture.id)
    if (!dbMatch) continue

    const short = fixture.fixture.status.short
    const newStatus = FINISHED_STATUSES.has(short) ? 'finished'
      : LIVE_STATUSES.has(short) ? 'live'
      : 'upcoming'

    const { error } = await supabase
      .from('matches')
      .update({
        score_home: fixture.goals.home,
        score_away: fixture.goals.away,
        status: newStatus
      })
      .eq('id', dbMatch.id)

    if (!error) updated++
  }

  return new Response(JSON.stringify({ updated, total: apiData.response.length }), {
    headers: { ...CORS, 'Content-Type': 'application/json' }
  })
})
