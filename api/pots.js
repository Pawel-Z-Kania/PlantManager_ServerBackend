// GET /api/pots — Zwraca listę doniczek wraz z najnowszym pomiarem oraz alertami (brak
// połączenia / poziom baterii) wyliczonymi centralnie na podstawie progów z system_config.
import { supabase } from './_lib/supabaseClient.js';
import { getSystemConfig } from './_lib/systemConfig.js';
import { computeAlerts } from './_lib/alerts.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // 1. Pobierz aktualne progi konfiguracyjne z Supabase
    const config = await getSystemConfig();

    // 2. Pobierz doniczki i najnowszy odczyt
    const { data: pots, error } = await supabase
      .from('pots')
      .select('id, name, board_id, last_signal_time, dry_calibration_value, wet_calibration_value, battery_mv, pot_measurements(sensor_value)')
      .order('measured_at', { referencedTable: 'pot_measurements', ascending: false })
      .limit(1, { referencedTable: 'pot_measurements' });

    if (error) throw error;

    const now = new Date();

    // 3. Centralne wyznaczanie alertów w backendzie
    const enrichedPots = (pots || []).map((pot) => ({
      ...pot,
      alerts: computeAlerts(pot, config, now),
    }));

    return res.status(200).json(enrichedPots);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
