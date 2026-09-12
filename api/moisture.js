// POST /api/moisture — Punkt przyjmowania odczytów z urządzenia (NodeMCU/ESP): zapisuje pomiar
// wilgotności i opcjonalnie poziom baterii, tworząc doniczkę przy jej pierwszym sygnale.
import { supabase } from './_lib/supabaseClient.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = req.headers['x-api-key'];
  if (process.env.API_SECRET_KEY && apiKey !== process.env.API_SECRET_KEY) {
    return res.status(401).json({ error: 'No authentication' });
  }

  try {
    const { board_id, value, battery_mv } = req.body; // Payload from NodeMCU

    if (!board_id || value === undefined) {
      return res.status(400).json({ error: 'Brak wymaganych danych: board_id lub value' });
    }

    // 65535 - treat as no reading
    const batteryMv = (battery_mv === undefined || battery_mv === 65535) ? null : battery_mv;

    // Step A: Get pot or create new
    let { data: pot, error: potError } = await supabase
      .from('pots')
      .select('id')
      .eq('board_id', board_id)
      .maybeSingle();

    if (potError) throw potError;

    if (!pot) {
      const { data: newPot, error: createError } = await supabase
        .from('pots')
        .insert([{
          board_id: board_id,
          name: `Nowa doniczka ${board_id}`,
          interval_minutes: 60
        }])
        .select('id')
        .single();

      if (createError) throw createError;
      pot = newPot;
    }

    const { data: acceptance, error: acceptanceError } = await supabase.rpc('accept_measurement', {
      p_pot_id: pot.id,
      p_sensor_value: value,
      p_battery_mv: batteryMv,
    });

    if (acceptanceError) throw acceptanceError;
    const outcome = acceptance?.[0];
    if (!outcome) throw new Error('Brak odpowiedzi funkcji accept_measurement');

    // Step C: Update latest known battery level
    if (batteryMv !== null) {
      const { error: updateError } = await supabase
        .from('pots')
        .update({ battery_mv: batteryMv })
        .eq('id', pot.id);

      if (updateError) throw updateError;
    }

    if (!outcome.saved) {
      return res.status(202).json({
        success: true,
        saved: false,
        message: 'Measurement skipped because of the global sampling interval',
        sensor_sample_interval_sec: outcome.sensor_sample_interval_sec,
        retry_after_sec: outcome.retry_after_sec,
      });
    }

    return res.status(200).json({
      success: true,
      saved: true,
      message: 'Measurement saved',
      sensor_sample_interval_sec: outcome.sensor_sample_interval_sec,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}