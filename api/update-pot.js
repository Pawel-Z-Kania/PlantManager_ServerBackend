// PUT /api/update-pot — Zapisuje nazwę doniczki, typ rośliny (opcjonalny) i progi kalibracji czujnika
// (sucho/mokro) edytowane przez użytkownika w aplikacji.
import { supabase } from './_lib/supabaseClient.js';

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

  const { id, name, dry_calibration_value, wet_calibration_value, plant_type } = req.body;

  if (!id || !name || dry_calibration_value === undefined || wet_calibration_value === undefined) {
    return res.status(400).json({ error: 'Brak wymaganych danych' });
  }

  const changes = { name, dry_calibration_value, wet_calibration_value };

  if (plant_type !== undefined) {
    if (typeof plant_type !== 'string') {
      return res.status(400).json({ error: 'Nieznany typ rośliny' });
    }

    const { data: knownType, error: typeError } = await supabase
      .from('plant_types')
      .select('code')
      .eq('code', plant_type)
      .maybeSingle();

    if (typeError) return res.status(500).json({ error: typeError.message });
    if (!knownType) return res.status(400).json({ error: 'Nieznany typ rośliny' });

    changes.plant_type = plant_type;
  }

  const { error } = await supabase
    .from('pots')
    .update(changes)
    .eq('id', id);

  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ success: true });
}