import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INCIDENT_KINDS,
  MAX_SEND_ATTEMPTS,
  buildAlertMessage,
  processIncidents,
} from '../api/_lib/incidents.js';

const NOW = new Date('2026-10-05T12:00:00Z');
const CONFIG = { connection_timeout_hours: 2, battery_critical_mv: 2700, battery_warning_mv: 2800 };
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const pot = (id, overrides = {}) => ({
  id,
  name: `Doniczka ${id}`,
  last_signal_time: hoursAgo(0.1),
  battery_mv: 3000,
  next_watered_date: null,
  ...overrides,
});
const offline = (id, hours = 3) => pot(id, { last_signal_time: hoursAgo(hours) });

function memoryStore(initial = []) {
  const rows = initial.map((row, index) => ({ id: index + 1, attempts: 0, closed_at: null, ...row }));
  let nextId = rows.length + 1;
  return {
    rows,
    open: () => rows.filter((row) => !row.closed_at),
    async closeIncidents(ids, at) {
      for (const row of rows) if (ids.includes(row.id) && !row.closed_at) row.closed_at = at.toISOString();
    },
    async openIncident(draft) {
      const taken = rows.some(
        (row) => !row.closed_at && row.kind === draft.kind && (row.pot_id ?? null) === (draft.pot_id ?? null)
      );
      if (taken) return null;
      const row = { id: nextId++, attempts: 0, closed_at: null, ...draft };
      rows.push(row);
      return row;
    },
    async recordAttempt(incident, { notified, at }) {
      const row = rows.find((r) => r.id === incident.id);
      row.attempts += 1;
      if (notified) row.notified_at = at.toISOString();
    },
  };
}

async function run(store, pots, { send } = {}) {
  const sent = [];
  const outcome = await processIncidents({
    pots,
    openIncidents: store.open(),
    config: CONFIG,
    now: NOW,
    store,
    send: async (message) => {
      if (send) await send(message);
      sent.push(message);
    },
  });
  return { outcome, sent };
}

describe('pot disconnection', () => {
  it('notifies once and stays quiet while the incident lasts', async () => {
    const store = memoryStore();
    const pots = [offline('a'), pot('b')];

    const first = await run(store, pots);
    assert.equal(first.sent.length, 1);
    assert.equal(first.sent[0].data.kind, INCIDENT_KINDS.POT_DISCONNECTED);
    assert.equal(first.sent[0].data.pot_id, 'a');
    assert.match(first.sent[0].title, /Doniczka a/);

    const second = await run(store, pots);
    assert.equal(second.sent.length, 0);
  });

  it('ignores pots that never reported a signal', async () => {
    const store = memoryStore();
    const { sent } = await run(store, [pot('a', { last_signal_time: null }), pot('b')]);
    assert.equal(sent.length, 0);
    assert.equal(store.open().length, 0);
  });

  it('notifies again only after the pot recovered', async () => {
    const store = memoryStore();
    assert.equal((await run(store, [offline('a'), pot('b')])).sent.length, 1);

    await run(store, [pot('a'), pot('b')]);
    assert.equal(store.open().length, 0);

    assert.equal((await run(store, [offline('a'), pot('b')])).sent.length, 1);
  });

  it('does not wait for the timeout to pass', async () => {
    const { sent } = await run(memoryStore(), [pot('a', { last_signal_time: hoursAgo(1.9) }), pot('b')]);
    assert.equal(sent.length, 0);
  });
});

describe('all pots disconnected', () => {
  it('reports a single pot as a per-pot incident, not an aggregate', async () => {
    const { sent } = await run(memoryStore(), [offline('a')]);
    assert.deepEqual(sent.map((m) => m.data.kind), [INCIDENT_KINDS.POT_DISCONNECTED]);
  });

  it('sends one aggregate alert and opens per-pot incidents silently', async () => {
    const store = memoryStore();
    const { sent, outcome } = await run(store, [offline('a'), offline('b')]);

    assert.deepEqual(sent.map((m) => m.data.kind), [INCIDENT_KINDS.ALL_POTS_DISCONNECTED]);
    assert.equal(sent[0].data.pot_id, undefined);
    assert.equal(outcome.suppressed, 2);

    const perPot = store.open().filter((row) => row.kind === INCIDENT_KINDS.POT_DISCONNECTED);
    assert.equal(perPot.length, 2);
    assert.ok(perPot.every((row) => row.suppressed && row.notified_at));
  });

  it('does not replay suppressed alerts after a partial recovery', async () => {
    const store = memoryStore();
    await run(store, [offline('a'), offline('b')]);

    const { sent } = await run(store, [pot('a'), offline('b')]);

    assert.equal(sent.length, 0);
    assert.deepEqual(
      store.open().map((row) => [row.kind, row.pot_id]),
      [[INCIDENT_KINDS.POT_DISCONNECTED, 'b']]
    );
  });

  it('alerts about a pot that was already announced before the aggregate outage', async () => {
    const store = memoryStore();
    assert.equal((await run(store, [offline('a'), pot('b')])).sent.length, 1);

    const { sent } = await run(store, [offline('a'), offline('b')]);

    assert.deepEqual(sent.map((m) => m.data.kind), [INCIDENT_KINDS.ALL_POTS_DISCONNECTED]);
  });
});

describe('watering due', () => {
  it('notifies once when the forecast date has passed', async () => {
    const store = memoryStore();
    const pots = [pot('a', { next_watered_date: hoursAgo(1) }), pot('b')];

    const first = await run(store, pots);
    assert.deepEqual(first.sent.map((m) => [m.data.kind, m.data.pot_id]), [[INCIDENT_KINDS.WATERING_DUE, 'a']]);
    assert.equal(first.sent[0].title, 'Czas podlać: Doniczka a');

    assert.equal((await run(store, pots)).sent.length, 0);
  });

  it('stays quiet for a future or missing date', async () => {
    const future = new Date(NOW.getTime() + 3_600_000).toISOString();
    const { sent } = await run(memoryStore(), [pot('a', { next_watered_date: future }), pot('b')]);
    assert.equal(sent.length, 0);
  });

  it('closes after watering and allows the next cycle to notify again', async () => {
    const store = memoryStore();
    const due = pot('a', { next_watered_date: hoursAgo(1) });
    assert.equal((await run(store, [due])).sent.length, 1);

    await run(store, [pot('a', { next_watered_date: null })]);
    assert.equal(store.open().length, 0);

    assert.equal((await run(store, [due])).sent.length, 1);
  });
});

describe('delivery failures', () => {
  const dueOnce = () => [pot('a', { next_watered_date: hoursAgo(1) })];

  it('retries a failed delivery and records the attempts', async () => {
    const store = memoryStore();
    const failing = await run(store, dueOnce(), {
      send: async () => {
        throw new Error('FCM niedostępny');
      },
    });
    assert.equal(failing.outcome.failed, 1);
    assert.equal(failing.outcome.failures[0].error, 'FCM niedostępny');
    assert.equal(store.open()[0].attempts, 1);
    assert.equal(store.open()[0].notified_at ?? null, null);

    const retry = await run(store, dueOnce());
    assert.equal(retry.sent.length, 1);
    assert.ok(store.open()[0].notified_at);

    assert.equal((await run(store, dueOnce())).sent.length, 0);
  });

  it('gives up after the attempt limit', async () => {
    const store = memoryStore([
      { kind: INCIDENT_KINDS.WATERING_DUE, pot_id: 'a', suppressed: false, notified_at: null, attempts: MAX_SEND_ATTEMPTS },
    ]);
    assert.equal((await run(store, dueOnce())).sent.length, 0);
  });

  it('keeps delivering the remaining alerts when one fails', async () => {
    const store = memoryStore();
    let calls = 0;
    const { outcome, sent } = await run(
      store,
      [pot('a', { next_watered_date: hoursAgo(1) }), pot('b', { next_watered_date: hoursAgo(1) })],
      {
        send: async () => {
          calls += 1;
          if (calls === 1) throw new Error('boom');
        },
      }
    );
    assert.equal(outcome.failed, 1);
    assert.equal(outcome.sent, 1);
    assert.equal(sent.length, 1);
  });

  it('does not send an incident that a concurrent run already claimed', async () => {
    const store = memoryStore();
    store.openIncident = async () => null;
    const { sent } = await run(store, dueOnce());
    assert.equal(sent.length, 0);
  });
});

describe('buildAlertMessage', () => {
  it('describes how long a pot has been silent', () => {
    const incident = { kind: INCIDENT_KINDS.POT_DISCONNECTED, pot_id: 'a' };
    const message = buildAlertMessage(incident, offline('a', 5), CONFIG, NOW);
    assert.equal(message.title, 'Brak sygnału: Doniczka a');
    assert.equal(message.body, 'Brak pomiaru od 5 h.');
    assert.equal(message.tag, 'pot_disconnected:a');
  });

  it('switches to days for long outages', () => {
    const incident = { kind: INCIDENT_KINDS.POT_DISCONNECTED, pot_id: 'a' };
    assert.equal(buildAlertMessage(incident, offline('a', 72), CONFIG, NOW).body, 'Brak pomiaru od 3 dni.');
  });

  it('uses the configured timeout in the aggregate alert', () => {
    const incident = { kind: INCIDENT_KINDS.ALL_POTS_DISCONNECTED, pot_id: null };
    const message = buildAlertMessage(incident, undefined, CONFIG, NOW);
    assert.equal(message.title, 'Brak sygnału ze wszystkich doniczek');
    assert.equal(message.body, 'Żadna doniczka nie wysłała pomiaru od ponad 2 h.');
    assert.equal(message.tag, 'all_pots_disconnected:all');
  });
});
