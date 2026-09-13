// GET/PUT /api/config — Odczyt i edycja globalnych progów systemowych (bateria, limit czasu
// bez połączenia) w tabeli system_config; te wartości napędzają logikę alertów w pots.js
// i watchdog.js. Brak jeszcze ekranu ustawień w aplikacji — dziś wywoływane ręcznie/administracyjnie.
import { supabase } from './_lib/supabaseClient.js';
import { getSystemConfig } from './_lib/systemConfig.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PUT,POST');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, x-api-key'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const apiKey = req.headers['x-api-key'];
  if (process.env.API_SECRET_KEY && apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: 'No authentication' });
  }

  try {
    if (req.method === 'GET') {
      const config = await getSystemConfig();
      return res.status(200).json(config);
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const { config_version, ...body } = req.body;
      if (body.sensor_sample_interval_sec !== undefined &&
          (!Number.isInteger(body.sensor_sample_interval_sec) ||
           body.sensor_sample_interval_sec < 1 ||
           body.sensor_sample_interval_sec > 3600)) {
        return res.status(400).json({ error: 'sensor_sample_interval_sec must be an integer from 1 to 3600' });
      }

      const { data, error } = await supabase
        .rpc('update_system_config', { p_config: body });

      if (error) throw error;
      return res.status(200).json({ success: true, config: data[0] });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}