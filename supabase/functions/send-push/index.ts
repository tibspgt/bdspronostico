import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  // Préflight CORS (appel depuis le navigateur)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const supabaseUrl  = Deno.env.get('SUPABASE_URL')!;
  const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const vapidPublic  = Deno.env.get('VAPID_PUBLIC_KEY')!;
  const vapidPrivate = Deno.env.get('VAPID_PRIVATE_KEY')!;
  const vapidContact = Deno.env.get('VAPID_CONTACT') || 'mailto:admin@example.com';

  webpush.setVapidDetails(vapidContact, vapidPublic, vapidPrivate);

  const sb = createClient(supabaseUrl, serviceKey);
  const body = await req.json().catch(() => null);

  // ── Mode CIBLÉ : une notif personnalisée par joueur ──
  // body = { title, notifications: [{ player_id, body, title? }, ...] }
  if (body && Array.isArray(body.notifications) && body.notifications.length) {
    const defaultTitle = body.title || '⚽ CDM 2026';
    const ids = body.notifications.map((n: any) => n.player_id).filter(Boolean);

    const { data: subs } = await sb
      .from('push_subscriptions')
      .select('player_id, subscription')
      .in('player_id', ids);

    const byPlayer = new Map((subs || []).map((s: any) => [s.player_id, s.subscription]));

    const results = await Promise.allSettled(
      body.notifications.map((n: any) => {
        const sub = byPlayer.get(n.player_id);
        if (!sub) return Promise.resolve('no-sub'); // joueur sans notifs activées
        const payload = JSON.stringify({ title: n.title || defaultTitle, body: n.body });
        return webpush.sendNotification(sub, payload);
      })
    );

    const sent = results.filter(r => r.status === 'fulfilled' && r.value !== 'no-sub').length;
    return new Response(JSON.stringify({ mode: 'targeted', sent, total: body.notifications.length }), {
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }

  // ── Mode GÉNÉRIQUE : rappel envoyé à tous les abonnés (comportement par défaut) ──
  const { data: subs, error } = await sb.from('push_subscriptions').select('subscription');
  if (error || !subs || subs.length === 0) {
    return new Response(JSON.stringify({ mode: 'broadcast', message: 'Aucun abonné', sent: 0 }), {
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  }

  const payload = JSON.stringify({
    title: (body && body.title) || '⚽ CDM 2026 — Rappel pronostics',
    body:  (body && body.body)  || 'Les matchs approchent ! Vérifie que tes pronostics sont bien remplis.',
  });

  const results = await Promise.allSettled(
    subs.map(row => webpush.sendNotification(row.subscription, payload))
  );

  const sent = results.filter(r => r.status === 'fulfilled').length;
  return new Response(JSON.stringify({ mode: 'broadcast', sent, total: subs.length }), {
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
});
