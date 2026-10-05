// Wysyłka push przez FCM HTTP v1 bez dodatkowych zależności: JWT (RS256) podpisany kluczem konta
// serwisowego jest wymieniany na token OAuth, a wiadomość trafia na temat odbierany przez aplikację.
import { createSign } from 'node:crypto';

// Muszą być zgodne z klientem: PushNotificationService.topic i kanałem w MainActivity.kt.
export const ALERT_TOPIC = 'pot-alerts';
export const ALERT_CHANNEL_ID = 'pot_alerts';

const OAUTH_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const MESSAGE_TTL = '86400s';
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export function readServiceAccount(raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON nie jest skonfigurowany');

  let account;
  try {
    account = JSON.parse(raw);
  } catch {
    // Treść błędu JSON.parse mogłaby zawierać fragment klucza.
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON nie jest poprawnym JSON-em');
  }

  for (const field of ['project_id', 'client_email', 'private_key']) {
    if (typeof account?.[field] !== 'string' || account[field] === '') {
      throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON: brak pola ${field}`);
    }
  }
  return account;
}

export function createJwt(account, nowMs) {
  const issuedAt = Math.floor(nowMs / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iss: account.client_email,
    scope: OAUTH_SCOPE,
    aud: account.token_uri ?? DEFAULT_TOKEN_URI,
    iat: issuedAt,
    exp: issuedAt + 3600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key);
  return `${unsigned}.${signature.toString('base64url')}`;
}

export function buildMessage({ title, body, tag, data }) {
  return {
    message: {
      topic: ALERT_TOPIC,
      notification: { title, body },
      data,
      android: {
        priority: 'HIGH',
        ttl: MESSAGE_TTL,
        // Ten sam tag zastępuje poprzednie powiadomienie danego incydentu zamiast je dublować.
        notification: { channel_id: ALERT_CHANNEL_ID, tag },
      },
    },
  };
}

export function createFcmSender({ account, fetchImpl = fetch, now = Date.now }) {
  const tokenUri = account.token_uri ?? DEFAULT_TOKEN_URI;
  let cached = null;

  async function accessToken() {
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > now()) return cached.token;

    const response = await fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: createJwt(account, now()),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Błąd autoryzacji FCM: ${response.status}`);

    const { access_token: token, expires_in: expiresIn } = await response.json();
    cached = { token, expiresAt: now() + expiresIn * 1000 };
    return token;
  }

  return async function send(alert) {
    const token = await accessToken();
    const response = await fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(buildMessage(alert)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    if (!response.ok) {
      throw new Error(`Błąd FCM: ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
  };
}
