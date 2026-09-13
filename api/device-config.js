// GET /api/device-config — Minimalna, autoryzowana konfiguracja dla Centralki.
import { getSystemConfig } from './_lib/systemConfig.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = req.headers['x-api-key'];
  if (process.env.API_SECRET_KEY && apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: 'No authentication' });
  }

  try {
    const config = await getSystemConfig();
    return res.status(200).json({
      config_version: config.config_version,
      sensor_sample_interval_sec: config.sensor_sample_interval_sec,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}