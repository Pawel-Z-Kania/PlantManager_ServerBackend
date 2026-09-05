// GET /api/watchdog — Vercel Cron (patrz vercel.json, raz dziennie). Sprawdza doniczki pod kątem
// niskiego poziomu baterii (te same progi/logika co pots.js, przez computeAlerts) oraz opóźnień
// w raportowaniu względem oczekiwanego interwału danej doniczki (interval_minutes) — osobny,
// wcześniejszy sygnał ostrzegawczy pomyślany pod przyszłe powiadomienia push/e-mail.
import { supabase } from './_lib/supabaseClient.js';
import { getSystemConfig } from './_lib/systemConfig.js';
import { computeAlerts } from './_lib/alerts.js';

export default async function handler(req, res) {
  // Opcjonalne zabezpieczenie: Vercel Cron przesyła specjalny nagłówek Authorization
  // Możesz go zweryfikować, jeśli ustawisz CRON_SECRET w zmiennych środowiskowych Vercela
  if (process.env.CRON_SECRET) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: 'Brak autoryzacji' });
    }
  }

  console.log('[WATCHDOG] Sprawdzanie opóźnień czujników...');

  try {
    // Pobierz dynamiczne progi z system_config
    const config = await getSystemConfig();

    // Zapytanie do bazy o doniczki wraz z parametrami interwału
    const { data: pots, error } = await supabase
      .from('pots')
      .select('id, name, last_signal_time, interval_minutes, battery_mv');

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

      if (!pot.last_signal_time) return; // Pomijamy doniczki bez żadnego sygnału

      const lastTime = new Date(pot.last_signal_time);
      const diffMs = now - lastTime;
      const diffMin = diffMs / 1000 / 60;

      if (diffMin > pot.interval_minutes) {
        const overDueMin = Math.round(diffMin);
        console.warn(
          `[!! ALARM !!] Doniczka "${pot.name}" nie dawała znaku przez ${overDueMin} min (limit: ${pot.interval_minutes} min)!`
        );

        // [TUTAJ PÓŹNIEJ WPADNIEMY Z FIREBASE / PUSH NOTIFICATIONS / EMAIL]

        alerts.push({
          type: 'overdue',
          pot_id: pot.id,
          name: pot.name,
          overdue_minutes: overDueMin,
          limit_minutes: pot.interval_minutes,
        });
      }
    });

    return res.status(200).json({
      success: true,
      checked_pots: pots.length,
      alerts_count: alerts.length,
      alerts: alerts,
    });
  } catch (err) {
    console.error('[WATCHDOG] Błąd wykonania:', err.message);
    return res.status(500).json({ error: err.message });
  }
}