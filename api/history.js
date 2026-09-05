// GET /api/history — Zwraca pomiary wilgotności dla danej doniczki (po board_id) w zadanym
// przedziale czasu, opcjonalnie agregowane do „kubełków” co N minut (bucket_minutes).
import { supabase } from './_lib/supabaseClient.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { board_id, from, to, bucket_minutes } = req.query;

  if (!board_id) {
    return res.status(400).json({ error: 'Required parameter board_id not provided' });
  }

  try {
    const { data: pot, error: potError } = await supabase
      .from('pots')
      .select('id')
      .eq('board_id', board_id)
      .maybeSingle();

    if (potError) throw potError;
    if (!pot) return res.status(404).json({ error: 'Nie znaleziono doniczki' });

    const bucketMin = parseInt(bucket_minutes) || 0;
    // Higher cap for bucketed queries — raw rows are aggregated before response
    const safetyCap = bucketMin > 0 ? 50000 : 2000;

    let query = supabase
      .from('pot_measurements')
      .select('sensor_value, measured_at')
      .eq('pot_id', pot.id)
      .order('measured_at', { ascending: true })
      .limit(safetyCap);

    if (from) query = query.gte('measured_at', from);
    if (to)   query = query.lte('measured_at', to);

    const { data: history, error: historyError } = await query;
    if (historyError) throw historyError;

    if (bucketMin > 0 && history.length > 0) {
      const bucketMs = bucketMin * 60 * 1000;
      const buckets = {};
      for (const row of history) {
        const ts  = new Date(row.measured_at).getTime();
        const key = Math.floor(ts / bucketMs) * bucketMs;
        if (!buckets[key]) buckets[key] = { sum: 0, count: 0 };
        buckets[key].sum   += row.sensor_value;
        buckets[key].count += 1;
      }
      const aggregated = Object.entries(buckets)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([ts, { sum, count }]) => ({
          sensor_value: Math.round(sum / count),
          measured_at:  new Date(Number(ts)).toISOString(),
        }));
      return res.status(200).json({ data: aggregated });
    }

    return res.status(200).json({ data: history });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}