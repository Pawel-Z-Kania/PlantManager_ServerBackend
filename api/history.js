// GET /api/history — Zwraca pomiary wilgotności dla danej doniczki (po board_id) w zadanym
// przedziale czasu, opcjonalnie agregowane do „kubełków” co N minut (bucket_minutes).
import { supabase } from './_lib/supabaseClient.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { board_id, from, to, bucket_minutes } = req.query;

  if (!board_id || !from || !to) {
    return res.status(400).json({ error: 'Required parameters board_id, from and to not provided' });
  }

  const fromDate = new Date(from);
  const toDate = new Date(to);
  const bucketMin = Number.parseInt(bucket_minutes ?? '0', 10);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate >= toDate) {
    return res.status(400).json({ error: 'Invalid time range' });
  }
  if (!Number.isInteger(bucketMin) || bucketMin < 0 || bucketMin > 1440) {
    return res.status(400).json({ error: 'bucket_minutes must be an integer from 0 to 1440' });
  }

  try {
    const { data: pot, error: potError } = await supabase
      .from('pots')
      .select('id')
      .eq('board_id', board_id)
      .maybeSingle();

    if (potError) throw potError;
    if (!pot) return res.status(404).json({ error: 'Nie znaleziono doniczki' });

    const { data: history, error: historyError } = await supabase.rpc('get_pot_history', {
      p_pot_id: pot.id,
      p_from: fromDate.toISOString(),
      p_to: toDate.toISOString(),
      p_bucket_minutes: bucketMin,
    });
    if (historyError) throw historyError;

    const meta = {
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      bucket_minutes: bucketMin,
      source_row_count: history.reduce((total, row) => total + Number(row.sample_count), 0),
      truncated: false,
    };

    return res.status(200).json({ data: history, meta });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}