// Współdzielony klient Supabase (wyłącznie service role) używany przez
// wszystkie endpointy zamiast tworzenia osobnej instancji w każdym pliku.
import { createClient } from '@supabase/supabase-js';

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Brak zmiennej środowiskowej SUPABASE_SERVICE_ROLE_KEY');
}

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
