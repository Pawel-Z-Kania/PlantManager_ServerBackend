require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mqtt = require('mqtt');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

// 1. Inicjalizacja połączenia Supabase (jako Baza Danych)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 2. Inicjalizacja Express API
const app = express();
app.use(cors());
app.use(express.json());

// 3. Połączenie MQTT
const mqttClient = mqtt.connect(process.env.MQTT_URL, {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASSWORD,
  clientId: `backend_server_${Math.random().toString(16).slice(3)}`
});

// -- LOGIKA MQTT: Zbieranie danych i "stemplowanie" czasu na serwerze --
mqttClient.on('connect', () => {
  console.log('Połączono z MQTT Brokerem (Chmura)');
  mqttClient.subscribe(process.env.MQTT_TOPIC, (err) => {
    if (!err) console.log('Zasubskrybowano:', process.env.MQTT_TOPIC);
    else console.error('Błąd subskrypcji:', err);
  });
});

mqttClient.on('error', (err) => {
  console.error('[MQTT] Błąd połączenia:', err.message);
});

mqttClient.on('offline', () => {
  console.warn('[MQTT] Utracono połączenie (Offline)');
});

mqttClient.on('message', async (topic, message) => {
  try {
    // Arduino przysyła teraz payload: {"board_id": 1, "value": 45}
    const payload = JSON.parse(message.toString());
    console.log(`[MQTT] Nowy pomiar:`, payload);

    // Krok A: Pobierz wewnętrzne UUID doniczki z bazy na podstawie board_id z Arduino
    let { data: pot, error: potError } = await supabase
      .from('pots')
      .select('id')
      .eq('board_id', payload.board_id)
      .single();

    // Jeśli błąd (np. brak wiersza) lub doniczki jeszcze nie ma w bazie, to ją stwórz
    if (potError || !pot) {
      console.log(`[MQTT] Brak doniczki z board_id = ${payload.board_id}. Tworzenie nowej...`);
      
      const { data: newPot, error: createError } = await supabase
        .from('pots')
        .insert([{ 
          board_id: payload.board_id, 
          name: `Nowa doniczka ${payload.board_id}`, 
          interval_minutes: 60 // Domyślny interwał (godzina) - dostosuj według potrzeb
        }])
        .select('id') // Ważne: każemy bazie zwrócić nowe UUID
        .single();
        
      if (createError) {
        console.error(`[MQTT] Błąd tworzenia nowej doniczki w bazie:`, createError.message);
        return; 
      }
      
      // Podstawiamy nową doniczkę, żeby Krok B mógł odczytać 'pot.id'
      pot = newPot;
      console.log(`[MQTT] Nowa doniczka zapisana! ID w chmurze to: ${pot.id}`);
    }

    // Krok B: Zapisz wynik wraz z czasem do pot_measurements
    const { error: insertError } = await supabase.from('pot_measurements').insert([{
      pot_id: pot.id, // Używamy natywnego ID (UUID) z bazy
      sensor_value: payload.value
    }]);

    if(insertError) {
      console.error(`[MQTT] Błąd zapisu pomiaru w bazie:`, insertError.message);
      return; 
    }

    // Krok C: Uaktualnij czas życia pota (Logika Watchdoga)
    await supabase.from('pots')
      .update({ last_signal_time: new Date().toISOString() })
      .eq('id', pot.id);

  } catch (err) {
    console.error('Błąd parsowania wiadomości/bazy danych:', err.message);
  }
});


// -- LOGIKA WATCHDOGA (Cron Job) uruchamiany co 5 minut --
cron.schedule('*/5 * * * *', async () => {
  console.log('[WATCHDOG] Sprawdzanie opóźnień czujników...');
  
  // Zapytanie SQL, żeby uzyskać doniczki, dla których upłynął zadany interval_minutes.
  // Tu wykorzystujemy API Supabase z weryfikacją interwału po stronie JS (albo widoku w bazie)
  const { data: pots, error } = await supabase.from('pots').select('id, name, last_signal_time, interval_minutes');
  if (error) return console.error('Watchdog error:', error);

  pots.forEach(pot => {
    if (!pot.last_signal_time) return; // puste

    const lastTime = new Date(pot.last_signal_time);
    const now = new Date();
    const diffMs = now - lastTime;
    const diffMin = diffMs / 1000 / 60;

    if (diffMin > pot.interval_minutes) {
        // [TUTAJ PÓŹNIEJ WPADNIEMY Z FIREBASE (Push Notifications)]
        console.warn(`[!! ALARM !!] Doniczka "${pot.name}" nie dawała znaku przez ${Math.round(diffMin)} min (limit: ${pot.interval_minutes} min)!`);
    }
  });
});


// -- LOGIKA API (Przygotowane pod podpięcie z Fluttera) --
// Zamiast Fluttera czytającego MQTT na żywo, odpytuje bazę danych o potężne kwerendy historyczne.
app.get('/api/pots/:board_id/history', async (req, res) => {
  const { board_id } = req.params;
  
  const { data: pot } = await supabase.from('pots').select('id').eq('board_id', board_id).single();
  if(!pot) return res.status(404).json({error: 'Nie znaleziono doniczki'});

  // Pobierz ostatnie 50 wyników posortowanych po czasie 
  const { data: history, error } = await supabase
    .from('pot_measurements')
    .select('sensor_value, measured_at')
    .eq('pot_id', pot.id)
    .order('measured_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ data: history });
});


// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serwer SaaS działa na porcie ${PORT}`));