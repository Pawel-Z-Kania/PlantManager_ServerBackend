// Reguły incydentów powiadomień (rozłączenie, wszystkie offline, termin podlania). Zapis do bazy
// i wysyłkę wstrzykuje watchdog.js, więc całą logikę da się testować bez Supabase i FCM.
import { computeAlerts } from './alerts.js';

export const INCIDENT_KINDS = Object.freeze({
  POT_DISCONNECTED: 'pot_disconnected',
  ALL_POTS_DISCONNECTED: 'all_pots_disconnected',
  WATERING_DUE: 'watering_due',
});

export const MAX_SEND_ATTEMPTS = 3;

// Przy jednej doniczce "wszystkie offline" nie różni się od alarmu pojedynczego.
const MIN_POTS_FOR_AGGREGATE = 2;

const keyOf = (kind, potId) => `${kind}:${potId ?? ''}`;

function hasDisconnection(pot, config, now) {
  return computeAlerts(pot, config, now).some((alert) => alert.code === 'DISCONNECTION');
}

export function evaluateIncidents({ pots, openIncidents, config, now }) {
  // Doniczka bez żadnego sygnału nigdy nie była połączona, więc nie ma czego "utracić".
  const reporting = pots.filter((pot) => pot.last_signal_time);
  const disconnected = reporting.filter((pot) => hasDisconnection(pot, config, now));
  const allDisconnected =
    reporting.length >= MIN_POTS_FOR_AGGREGATE && disconnected.length === reporting.length;
  const wateringDue = pots.filter(
    (pot) => pot.next_watered_date && new Date(pot.next_watered_date) <= now
  );

  const desired = new Map();
  const want = (kind, potId = null) => desired.set(keyOf(kind, potId), { kind, pot_id: potId });

  if (allDisconnected) want(INCIDENT_KINDS.ALL_POTS_DISCONNECTED);
  for (const pot of disconnected) want(INCIDENT_KINDS.POT_DISCONNECTED, pot.id);
  for (const pot of wateringDue) want(INCIDENT_KINDS.WATERING_DUE, pot.id);

  const openByKey = new Map(openIncidents.map((i) => [keyOf(i.kind, i.pot_id), i]));

  return {
    close: openIncidents.filter((i) => !desired.has(keyOf(i.kind, i.pot_id))),
    open: [...desired.entries()]
      .filter(([key]) => !openByKey.has(key))
      .map(([, { kind, pot_id }]) => ({
        kind,
        pot_id,
        // Podczas awarii zbiorczej alarmy pojedyncze otwieramy po cichu, żeby po jej zakończeniu nie wracały zaległe.
        suppressed: kind === INCIDENT_KINDS.POT_DISCONNECTED && allDisconnected,
      })),
    retry: openIncidents.filter(
      (i) =>
        desired.has(keyOf(i.kind, i.pot_id)) &&
        !i.suppressed &&
        i.notified_at == null &&
        i.attempts < MAX_SEND_ATTEMPTS
    ),
  };
}

function formatElapsed(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} dni`;
}

export function buildAlertMessage(incident, pot, config, now) {
  const name = pot?.name ?? 'Doniczka';
  const tag = `${incident.kind}:${incident.pot_id ?? 'all'}`;
  const data = { kind: incident.kind, ...(incident.pot_id ? { pot_id: incident.pot_id } : {}) };

  switch (incident.kind) {
    case INCIDENT_KINDS.ALL_POTS_DISCONNECTED:
      return {
        title: 'Brak sygnału ze wszystkich doniczek',
        body: `Żadna doniczka nie wysłała pomiaru od ponad ${formatElapsed(config.connection_timeout_hours * 3_600_000)}.`,
        tag,
        data,
      };
    case INCIDENT_KINDS.WATERING_DUE:
      return {
        title: `Czas podlać: ${name}`,
        body: 'Prognozowany termin podlewania już nadszedł.',
        tag,
        data,
      };
    default:
      return {
        title: `Brak sygnału: ${name}`,
        body: pot?.last_signal_time
          ? `Brak pomiaru od ${formatElapsed(now - new Date(pot.last_signal_time))}.`
          : 'Doniczka nie wysyła pomiarów.',
        tag,
        data,
      };
  }
}

// store: { closeIncidents, openIncident, recordAttempt }; send: async (alert) => void (rzuca przy błędzie).
export async function processIncidents({ pots, openIncidents, config, now, store, send }) {
  const plan = evaluateIncidents({ pots, openIncidents, config, now });
  const potsById = new Map(pots.map((pot) => [pot.id, pot]));

  if (plan.close.length > 0) {
    await store.closeIncidents(plan.close.map((incident) => incident.id), now);
  }

  const toSend = [...plan.retry];
  let suppressed = 0;
  for (const draft of plan.open) {
    const incident = await store.openIncident({
      ...draft,
      notified_at: draft.suppressed ? now.toISOString() : null,
    });
    if (!incident) continue; // równoległy przebieg zajął ten incydent
    if (draft.suppressed) suppressed += 1;
    else toSend.push(incident);
  }

  let sent = 0;
  const failures = [];
  for (const incident of toSend) {
    const message = buildAlertMessage(incident, potsById.get(incident.pot_id), config, now);
    try {
      await send(message);
      await store.recordAttempt(incident, { notified: true, at: now });
      sent += 1;
    } catch (err) {
      console.error(`[WATCHDOG] Wysyłka ${message.tag} nieudana:`, err.message);
      await store.recordAttempt(incident, { notified: false, at: now });
      failures.push({ kind: incident.kind, pot_id: incident.pot_id, error: err.message });
    }
  }

  return {
    opened: plan.open.length,
    suppressed,
    closed: plan.close.length,
    sent,
    failed: failures.length,
    failures,
  };
}
