// Wspólne sprawdzenie nagłówka Authorization: Bearer <CRON_SECRET> (porównanie w stałym czasie).
import { timingSafeEqual } from 'node:crypto';

export function isAuthorizedCron(authHeader, secret) {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(authHeader ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
