// GET /api/plant-types — Lista typów roślin (kod + polska etykieta) do wyboru w aplikacji.
import { supabase } from './_lib/supabaseClient.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { data, error } = await supabase
    .from('plant_types')
    .select('code, label_pl')
    .order('sort_order', { ascending: true });

  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json(data);
}
