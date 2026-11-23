// SlotBook webhook signatures (docs/slotbook.md):
//
//   SlotBook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
//
// Checked against the raw body exactly as received, before it is parsed, with a constant-time
// comparison and a time window that limits replays.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far the signature's timestamp may be from our clock, either way. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * @typedef {{ ok: true } | { ok: false, reason: 'missing' | 'malformed' | 'stale' | 'mismatch' }} SignatureCheck
 */

/**
 * @param {{ header: string | string[] | undefined, rawBody: Buffer, secret: string, now?: number }} input
 *   `now` is in milliseconds (injectable for tests)
 * @returns {SignatureCheck} why it failed is for our logs only; callers just get a 401
 */
export function verifySignature({ header, rawBody, secret, now = Date.now() }) {
  if (!secret) throw new Error('SlotBook webhook secret is not configured');
  if (typeof header !== 'string' || header === '') return { ok: false, reason: 'missing' };

  const parsed = parseHeader(header);
  if (!parsed) return { ok: false, reason: 'malformed' };

  if (Math.abs(Math.floor(now / 1000) - parsed.timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'stale' };
  }

  const expected = createHmac('sha256', secret).update(`${parsed.timestamp}.`).update(rawBody).digest();
  // Any v1 may match, so SlotBook can sign with an old and a new secret while one is rotated.
  const matches = parsed.signatures.some((signature) => timingSafeEqual(expected, signature));
  return matches ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/**
 * Strict parsing: exactly one `t` (digits), at least one `v1` (64 hex digits), other keys
 * ignored so SlotBook can add schemes later.
 * @param {string} header
 * @returns {{ timestamp: number, signatures: Buffer[] } | null}
 */
function parseHeader(header) {
  const timestamps = [];
  const signatures = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) return null;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      if (!/^\d{1,12}$/.test(value)) return null;
      timestamps.push(Number(value));
    } else if (key === 'v1') {
      if (!/^[0-9a-f]{64}$/i.test(value)) return null;
      signatures.push(Buffer.from(value, 'hex'));
    }
  }
  if (timestamps.length !== 1 || signatures.length === 0) return null;
  return { timestamp: timestamps[0], signatures };
}
