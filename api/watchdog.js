// GET /api/watchdog — wywoływany co godzinę (Supabase pg_cron, patrz supabase/setup_watchdog_schedule.sql;
// Vercel Cron działa tylko raz na dobę). Wyznacza incydenty (utrata sygnału doniczki, utrata sygnału wszystkich
// doniczek, termin podlania) i wysyła każdy raz jako push FCM. Stan incydentów trzyma notification_incidents.
// Bateria jest tylko raportowana w odpowiedzi i logach, bez push. Wymaga CRON_SECRET (brak zmiennej = odmowa).
import { supabase } from './_lib/supabaseClient.js';
import { getSystemConfig } from './_lib/systemConfig.js';
import { computeAlerts } from './_lib/alerts.js';
import { isAuthorizedCron } from './_lib/cronAuth.js';
import { createFcmSender, readServiceAccount } from './_lib/fcm.js';
import { incidentStore } from './_lib/incidentStore.js';
import { processIncidents } from './_lib/incidents.js';

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[WATCHDOG] CRON_SECRET nie jest skonfigurowany');
    return res.status(500).json({ error: 'CRON_SECRET nie jest skonfigurowany' });
  }
  if (!isAuthorizedCron(req.headers.authorization, secret)) {
    return res.status(401).json({ error: 'Brak autoryzacji' });
  }

  console.log('[WATCHDOG] Sprawdzanie doniczek...');

  try {
    // Przed jakąkolwiek zmianą w bazie: brak konfiguracji FCM nie może zużywać prób wysyłki.
    const send = createFcmSender({ account: readServiceAccount() });
    const config = await getSystemConfig();

    const { data: pots, error } = await supabase
      .from('pots')
      .select('id, name, last_signal_time, battery_mv, next_watered_date');

    if (error) throw error;

    const now = new Date();
    const alerts = [];

    pots.forEach((pot) => {
      // Bateria: te same progi/logika co pots.js, zmapowane na format powiadomień watchdoga.
      const batteryAlert = computeAlerts(pot, config, now).find(
        (a) => a.code === 'CRITICAL_BATTERY' || a.code === 'LOW_BATTERY'
      );

      if (batteryAlert) {
        console.warn(
          `[!! ALARM !!] Doniczka "${pot.name}" ma niski poziom baterii: ${pot.battery_mv}mV (limit: ${config.battery_critical_mv}mV)!`
        );

        alerts.push({
          type: batteryAlert.code === 'CRITICAL_BATTERY' ? 'critical_battery' : 'low_battery',
          pot_id: pot.id,
          name: pot.name,
          battery_mv: pot.battery_mv,
          threshold_mv: config.battery_critical_mv,
        });
      }
    });

    const incidents = await processIncidents({
      pots,
      openIncidents: await incidentStore.loadOpen(),
      config,
      now,
      store: incidentStore,
      send,
    });

    return res.status(200).json({
      success: true,
      checked_pots: pots.length,
      alerts_count: alerts.length,
      alerts,
      incidents,
    });
  } catch (err) {
    console.error('[WATCHDOG] Błąd wykonania:', err.message);
    return res.status(500).json({ error: err.message });
  }
}