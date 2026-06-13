import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3';

Deno.serve(async () => {
  const supabaseUrl    = Deno.env.get('SUPABASE_URL')!;
  const serviceKey     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const vapidPublic    = Deno.env.get('VAPID_PUBLIC_KEY')!;
  const vapidPrivate   = Deno.env.get('VAPID_PRIVATE_KEY')!;
  const vapidContact   = Deno.env.get('VAPID_CONTACT') || 'mailto:admin@example.com';

  webpush.setVapidDetails(vapidContact, vapidPublic, vapidPrivate);

  const sb = createClient(supabaseUrl, serviceKey);
  const { data: subs, error } = await sb.from('push_subscriptions').select('subscription');

  if (error || !subs || subs.length === 0) {
    return new Response('Aucun abonné', { status: 200 });
  }

  const payload = JSON.stringify({
    title: '⚽ CDM 2026 — Rappel pronostics',
    body: 'Les matchs approchent ! Vérifie que tes pronostics sont bien remplis.',
  });

  const results = await Promise.allSettled(
    subs.map(row => webpush.sendNotification(row.subscription, payload))
  );

  const sent = results.filter(r => r.status === 'fulfilled').length;
  return new Response(`Envoyé: ${sent}/${subs.length}`, { status: 200 });
});
