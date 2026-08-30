import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

/*

COMMENTED OUT UNTIL AUTH WILL BE EXPANDED

  const apiKey = req.headers['x-api-key'];
  if (process.env.API_SECRET_KEY && apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: 'No authentication' });
  }
*/

  const { id, name, dry_calibration_value, wet_calibration_value } = req.body;

  if (!id || !name || dry_calibration_value === undefined || wet_calibration_value === undefined) {
    return res.status(400).json({ error: 'Brak wymaganych danych' });
  }

  const { error } = await supabase
    .from('pots')
    .update({ name, dry_calibration_value, wet_calibration_value })
    .eq('id', id);

  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ success: true });
}