import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Noms d'équipes français → anglais (API-Football)
const FR_TO_EN: Record<string, string[]> = {
  'Allemagne': ['Germany'], 'France': ['France'], 'Brésil': ['Brazil'],
  'Argentine': ['Argentina'], 'Espagne': ['Spain'], 'Pays-Bas': ['Netherlands'],
  'Portugal': ['Portugal'], 'Angleterre': ['England'],
  'États-Unis': ['USA', 'United States'], 'Mexique': ['Mexico'],
  'Canada': ['Canada'], 'Japon': ['Japan'], 'Corée du Sud': ['South Korea'],
  'Australie': ['Australia'], 'Maroc': ['Morocco'], 'Sénégal': ['Senegal'],
  "Côte d'Ivoire": ['Ivory Coast', 'Cote d\'Ivoire'],
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

function getEnNames(frName: string): string[] {
  return FR_TO_EN[frName] || [frName]
}

function parseDay(day: string): string | null {
  const MONTHS: Record<string, string> = {
    'janvier':'01','février':'02','mars':'03','avril':'04','mai':'05',
    'juin':'06','juillet':'07','août':'08','septembre':'09',
    'octobre':'10','novembre':'11','décembre':'12'
  }
  const parts = day.trim().toLowerCase().split(/\s+/)
  if (parts.length < 2) return null
  const d = parts[0].padStart(2, '0')
  const m = MONTHS[parts[1]]
  if (!m) return null
  return `2026-${m}-${d}`
}

function nameMatch(apiName: string, candidates: string[]): boolean {
  const api = apiName.toLowerCase()
  return candidates.some(c => {
    const cn = c.toLowerCase()
    return api === cn || api.includes(cn) || cn.includes(api)
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )
  const apiKey = Deno.env.get('FOOTBALL_API_KEY')!

  // 1. Récupérer tous les matchs WC 2026 depuis API-Football
  const res = await fetch('https://v3.football.api-sports.io/fixtures?league=1&season=2026', {
    headers: {
      'x-rapidapi-key': apiKey,
      'x-rapidapi-host': 'v3.football.api-sports.io'
    }
  })
  const apiData = await res.json()

  if (!apiData.response?.length) {
    return new Response(JSON.stringify({ error: 'Aucun match reçu de API-Football', raw: apiData }), {
      headers: { ...CORS, 'Content-Type': 'application/json' }, status: 500
    })
  }

  // 2. Récupérer nos matchs
  const { data: matches, error: dbErr } = await supabase
    .from('matches')
    .select('id, home, away, day, api_fixture_id')

  if (dbErr) {
    return new Response(JSON.stringify({ error: dbErr.message }), {
      headers: { ...CORS, 'Content-Type': 'application/json' }, status: 500
    })
  }

  // 3. Associer chaque match de notre DB à un fixture API-Football
  let updated = 0
  const unmatched: object[] = []

  for (const match of matches) {
    if (match.api_fixture_id) continue // déjà mappé

    const matchDate = parseDay(match.day)
    if (!matchDate) { unmatched.push({ reason: 'date_parse_fail', ...match }); continue }

    const homeEn = getEnNames(match.home)
    const awayEn = getEnNames(match.away)

    const fixture = apiData.response.find((f: any) => {
      const fDate = f.fixture.date.split('T')[0]
      return fDate === matchDate
        && nameMatch(f.teams.home.name, homeEn)
        && nameMatch(f.teams.away.name, awayEn)
    })

    if (fixture) {
      await supabase
        .from('matches')
        .update({ api_fixture_id: fixture.fixture.id })
        .eq('id', match.id)
      updated++
    } else {
      unmatched.push({ id: match.id, home: match.home, away: match.away, day: match.day, date: matchDate })
    }
  }

  return new Response(JSON.stringify({
    message: `${updated} match(s) mappé(s)`,
    updated,
    unmatched_count: unmatched.length,
    unmatched
  }), {
    headers: { ...CORS, 'Content-Type': 'application/json' }
  })
})
