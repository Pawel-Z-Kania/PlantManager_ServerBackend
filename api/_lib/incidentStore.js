// Zapis incydentów powiadomień w Supabase (tabela notification_incidents); jedyne miejsce z zapytaniami.
import { supabase } from './supabaseClient.js';

const TABLE = 'notification_incidents';
const UNIQUE_VIOLATION = '23505';

export const incidentStore = {
  async loadOpen() {
    const { data, error } = await supabase.from(TABLE).select('*').is('closed_at', null);
    if (error) throw error;
    return data ?? [];
  },

  async closeIncidents(ids, at) {
    const { error } = await supabase
      .from(TABLE)
      .update({ closed_at: at.toISOString() })
      .in('id', ids)
      .is('closed_at', null);
    if (error) throw error;
  },

  // Zwraca null, gdy ten sam incydent otworzył równolegle inny przebieg (indeks unikalny).
  async openIncident(draft) {
    const { data, error } = await supabase.from(TABLE).insert(draft).select().single();
    if (error?.code === UNIQUE_VIOLATION) return null;
    if (error) throw error;
    return data;
  },

  async recordAttempt(incident, { notified, at }) {
    const changes = { attempts: incident.attempts + 1 };
    if (notified) changes.notified_at = at.toISOString();

    const { error } = await supabase.from(TABLE).update(changes).eq('id', incident.id);
    if (error) throw error;
  },
};
