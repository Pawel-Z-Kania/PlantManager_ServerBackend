// Współdzielony klient Supabase (service role, z awaryjnym kluczem anon) używany przez
// wszystkie endpointy zamiast tworzenia osobnej instancji w każdym pliku.
import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);
