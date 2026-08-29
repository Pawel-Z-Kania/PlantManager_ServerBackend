import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  const { board_id } = req.query;

  if (!board_id) {
    return res.status(400).json({ error: 'Brak parametru board_id' });
  }

  const { data: pot } = await supabase
    .from('pots')
    .select('id')
    .eq('board_id', board_id)
    .single();

  if (!pot) return res.status(404).json({ error: 'Nie znaleziono doniczki' });

  const { data: history, error } = await supabase
    .from('pot_measurements')
    .select('sensor_value, measured_at')
    .eq('pot_id', pot.id)
    .order('measured_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ data: history });
}