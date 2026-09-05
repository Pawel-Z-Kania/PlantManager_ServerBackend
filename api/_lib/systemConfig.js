// Jedno źródło prawdy dla progów systemowych (system_config): wartości domyślne oraz
// odczyt z bazy z scalaniem, używane przez config.js, pots.js i watchdog.js.
import { supabase } from './supabaseClient.js';

export const DEFAULT_SYSTEM_CONFIG = {
  battery_critical_mv: 2700,
  battery_warning_mv: 2800,
  connection_timeout_hours: 2,
};

export async function getSystemConfig() {
  const { data, error } = await supabase
    .from('system_config')
    .select('*')
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return { ...DEFAULT_SYSTEM_CONFIG, ...data };
}
