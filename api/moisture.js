import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { board_id, value } = req.body; // Payload z mikrokontrolera

    if (!board_id || value === undefined) {
      return res.status(400).json({ error: 'Brak wymaganych danych: board_id lub value' });
    }

    // Krok A: Pobierz lub utwórz doniczkę
    let { data: pot, error: potError } = await supabase
      .from('pots')
      .select('id')
      .eq('board_id', board_id)
      .single();

    if (potError || !pot) {
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

    // Krok B: Zapisz pomiar
    const { error: insertError } = await supabase
      .from('pot_measurements')
      .insert([{ pot_id: pot.id, sensor_value: value }]);

    if (insertError) throw insertError;

    // Krok C: Aktualizacja ostatniego sygnału
    await supabase
      .from('pots')
      .update({ last_signal_time: new Date().toISOString() })
      .eq('id', pot.id);

    return res.status(200).json({ success: true, message: 'Pomiar zapisany' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}