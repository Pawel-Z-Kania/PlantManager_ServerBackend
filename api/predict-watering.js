// GET /api/predict-watering — Wywoływany co 3 h przez Supabase pg_cron (Vercel Hobby dopuszcza cron
// tylko raz na dobę). Liczy next_watered_date dla doniczek z last_watered_at i zapisuje wszystkie
// zmiany jednym wywołaniem RPC. Wymaga CRON_SECRET (brak zmiennej = odmowa, bez trybu otwartego).
import { supabase } from './_lib/supabaseClient.js';
import { isAuthorizedCron } from './_lib/cronAuth.js';
import { predictNextWatering } from './_lib/dryingCurve.js';

const BUCKET_MINUTES = 60;
// Zmiana poniżej progu nie jest zapisywana, żeby data w aplikacji nie "pływała" po każdym przebiegu.
const MIN_CHANGE_SEC = 2 * 3600;

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[PREDICT] CRON_SECRET nie jest skonfigurowany');
    return res.status(500).json({ error: 'CRON_SECRET nie jest skonfigurowany' });
  }
  if (!isAuthorizedCron(req.headers.authorization, secret)) {
    return res.status(401).json({ error: 'Brak autoryzacji' });
  }

  try {
    const { data: pots, error } = await supabase.rpc('get_watering_curve_inputs', {
      p_bucket_minutes: BUCKET_MINUTES,
    });
    if (error) throw error;

    const nowSec = Date.now() / 1000;
    const updates = [];
    const skipped = {};
    const failedPotIds = [];
    let predicted = 0;

    for (const pot of pots ?? []) {
      try {
        const result = predictNextWatering(pot, nowSec);

        if (result.status !== 'ok') {
          skipped[result.reason] = (skipped[result.reason] ?? 0) + 1;
          continue;
        }

        predicted += 1;
        const currentSec = pot.next_watered_date ? Date.parse(pot.next_watered_date) / 1000 : null;
        if (currentSec !== null && Math.abs(result.dateSec - currentSec) < MIN_CHANGE_SEC) continue;

        updates.push({
          pot_id: pot.pot_id,
          // Oryginalny tekst z bazy (mikrosekundy), bo RPC porównuje go z last_watered_at.
          expected_last_watered_at: pot.last_watered_at,
          next_watered_date: new Date(result.dateSec * 1000).toISOString(),
          source: result.source,
          details: { ...result.details, plant_type: pot.plant_type },
        });
      } catch (potError) {
        console.error(`[PREDICT] Błąd doniczki ${pot.pot_id}:`, potError.message);
        failedPotIds.push(pot.pot_id);
      }
    }

    let applied = 0;
    if (updates.length > 0) {
      const { data: outcome, error: applyError } = await supabase.rpc('apply_watering_predictions', {
        p_predictions: updates,
      });
      if (applyError) throw applyError;
      applied = outcome?.[0]?.applied ?? 0;
    }

    return res.status(200).json({
      success: true,
      checked_pots: pots?.length ?? 0,
      predicted,
      to_update: updates.length,
      applied,
      skipped,
      failed_pots: failedPotIds.length,
    });
  } catch (err) {
    console.error('[PREDICT] Błąd wykonania:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
