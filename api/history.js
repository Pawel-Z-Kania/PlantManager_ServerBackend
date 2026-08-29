import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { board_id } = req.query;

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
    if (!pot) return res.status(404).json({
      error: "Nie znaleziono doniczki"
    })

    const { data: history, error: historyError } = await supabase
      .from('pot_measurements')
      .select('sensor_value, measured_at')
      .eq('pot_id', pot.id)
      .order('measured_at', { ascending: false })
      .limit(50);

    if (historyError) throw historyError;

    return res.status(200).json({ data: history })
  }
  catch (err) {
    return res.status(500).json({ error: err.message });
  }
}