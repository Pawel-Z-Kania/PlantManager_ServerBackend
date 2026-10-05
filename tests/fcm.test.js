import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  ALERT_CHANNEL_ID,
  ALERT_TOPIC,
  buildMessage,
  createFcmSender,
  createJwt,
  readServiceAccount,
} from '../api/_lib/fcm.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = {
  project_id: 'plant-test',
  client_email: 'sender@plant-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
};
const alert = { title: 'T', body: 'B', tag: 'watering_due:a', data: { kind: 'watering_due', pot_id: 'a' } };

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe('readServiceAccount', () => {
  it('requires the variable and the key fields', () => {
    assert.throws(() => readServiceAccount(''), /nie jest skonfigurowany/);
    assert.throws(() => readServiceAccount('{"project_id":"x"}'), /brak pola client_email/);
  });

  it('does not echo the raw value when it is not valid JSON', () => {
    assert.throws(
      () => readServiceAccount('SECRET-KEY-FRAGMENT'),
      (err) => /nie jest poprawnym JSON/.test(err.message) && !err.message.includes('SECRET')
    );
  });

  it('accepts a complete service account', () => {
    assert.equal(readServiceAccount(JSON.stringify(account)).project_id, 'plant-test');
  });
});

describe('createJwt', () => {
  it('produces a verifiable RS256 token with the FCM scope', () => {
    const [header, claims, signature] = createJwt(account, 1_800_000_000_000).split('.');
    const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());

    assert.deepEqual(decode(header), { alg: 'RS256', typ: 'JWT' });
    assert.equal(decode(claims).iss, account.client_email);
    assert.equal(decode(claims).scope, 'https://www.googleapis.com/auth/firebase.messaging');
    assert.equal(decode(claims).exp - decode(claims).iat, 3600);

    const verifier = createVerify('RSA-SHA256').update(`${header}.${claims}`);
    assert.ok(verifier.verify(publicKey, Buffer.from(signature, 'base64url')));
  });
});

describe('buildMessage', () => {
  it('targets the topic with a high priority notification on the alert channel', () => {
    const { message } = buildMessage(alert);
    assert.equal(message.topic, ALERT_TOPIC);
    assert.deepEqual(message.notification, { title: 'T', body: 'B' });
    assert.deepEqual(message.data, alert.data);
    assert.equal(message.android.priority, 'HIGH');
    assert.equal(message.android.ttl, '86400s');
    assert.deepEqual(message.android.notification, { channel_id: ALERT_CHANNEL_ID, tag: alert.tag });
  });
});

describe('createFcmSender', () => {
  function fakeFetch(responses) {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return responses.shift();
    };
    return { calls, fetchImpl };
  }

  it('exchanges the JWT once and reuses the token for later messages', async () => {
    const { calls, fetchImpl } = fakeFetch([
      json({ access_token: 'tok', expires_in: 3600 }),
      json({ name: 'm1' }),
      json({ name: 'm2' }),
    ]);
    const send = createFcmSender({ account, fetchImpl, now: () => 1_800_000_000_000 });

    await send(alert);
    await send(alert);

    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
    assert.equal(calls[0].options.body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.equal(calls[1].url, 'https://fcm.googleapis.com/v1/projects/plant-test/messages:send');
    assert.equal(calls[1].options.headers.Authorization, 'Bearer tok');
    assert.equal(JSON.parse(calls[1].options.body).message.topic, ALERT_TOPIC);
  });

  it('requests a new token once the cached one is about to expire', async () => {
    const { calls, fetchImpl } = fakeFetch([
      json({ access_token: 'tok1', expires_in: 3600 }),
      json({}),
      json({ access_token: 'tok2', expires_in: 3600 }),
      json({}),
    ]);
    let now = 1_800_000_000_000;
    const send = createFcmSender({ account, fetchImpl, now: () => now });

    await send(alert);
    now += 3_560_000;
    await send(alert);

    assert.equal(calls.length, 4);
    assert.equal(calls[3].options.headers.Authorization, 'Bearer tok2');
  });

  it('throws on an FCM error response', async () => {
    const { fetchImpl } = fakeFetch([json({ access_token: 'tok', expires_in: 3600 }), json({ error: 'bad' }, 400)]);
    const send = createFcmSender({ account, fetchImpl });
    await assert.rejects(send(alert), /Błąd FCM: 400/);
  });

  it('throws when the OAuth exchange fails', async () => {
    const { fetchImpl } = fakeFetch([json({ error: 'invalid_grant' }, 400)]);
    const send = createFcmSender({ account, fetchImpl });
    await assert.rejects(send(alert), /Błąd autoryzacji FCM: 400/);
  });
});
