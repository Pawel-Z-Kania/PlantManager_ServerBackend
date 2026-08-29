import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
    // Zapytanie do bazy o doniczki wraz z parametrami interwału
    const { data: pots, error } = await supabase
      .from('pots')
      .select('id, name, last_signal_time, interval_minutes');

    if (error) throw error;

    const alerts = [];

    pots.forEach((pot) => {
      if (!pot.last_signal_time) return; // Pomijamy doniczki bez żadnego sygnału

      const lastTime = new Date(pot.last_signal_time);
      const now = new Date();
      const diffMs = now - lastTime;
      const diffMin = diffMs / 1000 / 60;

      if (diffMin > pot.interval_minutes) {
        const overDueMin = Math.round(diffMin);
        console.warn(
          `[!! ALARM !!] Doniczka "${pot.name}" nie dawała znaku przez ${overDueMin} min (limit: ${pot.interval_minutes} min)!`
        );

        // [TUTAJ PÓŹNIEJ WPADNIEMY Z FIREBASE / PUSH NOTIFICATIONS / EMAIL]
        
        alerts.push({
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