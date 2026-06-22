import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Mois FR -> numéro (1-12)
const MONTHS: Record<string, number> = {
  janvier: 1, février: 2, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6,
  juillet: 7, août: 8, aout: 8, septembre: 9, octobre: 10, novembre: 11,
  décembre: 12, decembre: 12,
};

// La Coupe du Monde 2026 se déroule entièrement en été → Paris = UTC+2 (CEST).
const PARIS_OFFSET_MS = 2 * 60 * 60 * 1000;

// Renvoie l'instant (ms epoch UTC) du coup d'envoi à partir de "22 juin" + "23:00".
function kickoffMs(day: string, matchTime: string): number | null {
  if (!day || !matchTime) return null;
  const dm = day.trim().match(/(\d+)\s+(\S+)/);
  if (!dm) return null;
  const dayNum = parseInt(dm[1], 10);
  const mon = MONTHS[dm[2].toLowerCase()];
  if (!mon) return null;
  const tm = matchTime.match(/(\d{1,2})[:h](\d{2})/);
  if (!tm) return null;
  const h = parseInt(tm[1], 10), min = parseInt(tm[2], 10);
  // Les champs sont en heure de Paris → on retire le décalage pour obtenir l'UTC.
  return Date.UTC(2026, mon - 1, dayNum, h, min) - PARIS_OFFSET_MS;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  webpush.setVapidDetails(
    Deno.env.get('VAPID_CONTACT') || 'mailto:admin@example.com',
    Deno.env.get('VAPID_PUBLIC_KEY')!,
    Deno.env.get('VAPID_PRIVATE_KEY')!,
  );

  // Matchs à venir, pas encore rappelés
  const { data: matches, error } = await sb
    .from('matches')
    .select('id, home, away, day, match_time, status, reminder_notified_at')
    .eq('status', 'upcoming')
    .is('reminder_notified_at', null);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...CORS, 'Content-Type': 'application/json' }, status: 500,
    });
  }

  const now = Date.now();
  // On rappelle ~1h avant : fenêtre 45–75 min avant le coup d'envoi.
  const due = (matches || []).filter((m) => {
    const ko = kickoffMs(m.day, m.match_time);
    if (ko == null) return false;
    const minsUntil = (ko - now) / 60000;
    return minsUntil >= 45 && minsUntil <= 75;
  });

  if (due.length === 0) {
    return new Response(JSON.stringify({ reminded: 0, checked: matches?.length || 0 }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  // Abonnés (tout le monde reçoit le rappel)
  const { data: subs } = await sb.from('push_subscriptions').select('subscription');
  const allSubs = subs || [];

  // Aucun abonné : on ne "consomme" pas le rappel, on réessaiera au prochain tick.
  if (allSubs.length === 0) {
    return new Response(JSON.stringify({ reminded: 0, due: due.length, reason: 'no subscribers' }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  let reminded = 0, totalSent = 0;
  for (const m of due) {
    // Verrou atomique : on ne rappelle qu'une fois, même si deux exécutions se chevauchent.
    const { data: claimed } = await sb
      .from('matches')
      .update({ reminder_notified_at: new Date().toISOString() })
      .eq('id', m.id)
      .is('reminder_notified_at', null)
      .select('id');
    if (!claimed || claimed.length === 0) continue;

    const payload = JSON.stringify({
      title: '⏳ Coup d\'envoi dans 1h !',
      body: `${m.home} vs ${m.away} à ${m.match_time} — n'oublie pas ton prono ! ⚽`,
    });
    const results = await Promise.allSettled(
      allSubs.map((row) => webpush.sendNotification(row.subscription, payload)),
    );
    totalSent += results.filter((r) => r.status === 'fulfilled').length;
    reminded++;
  }

  return new Response(JSON.stringify({ reminded, totalSent, subscribers: allSubs.length }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
});
