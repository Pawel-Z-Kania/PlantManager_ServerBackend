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
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.method === 'GET') {
      const config = await getSystemConfig();
      return res.status(200).json(config);
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const body = req.body;
      const { data, error } = await supabase
        .from('system_config')
        .upsert({ id: 1, ...body })
        .select();

      if (error) throw error;
      return res.status(200).json({ success: true, config: data });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}