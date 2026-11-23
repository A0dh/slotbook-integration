import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { verifySignature } from './signature.js';

const secret = 'test-secret';
const now = Date.UTC(2026, 10, 20, 10, 0, 0);
const t = Math.floor(now / 1000);
// A real sample webhook, byte for byte.
const rawBody = readFileSync(new URL('../../../data/slotbook/webhooks/01-adult.json', import.meta.url));

/** Signs the way SlotBook does (docs/slotbook.md). */
const sign = (body, timestamp = t) => createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

describe('verifySignature', () => {
  it('accepts only the exact raw body, signed recently with our secret', () => {
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(rawBody.toString())));
    const cases = [
      [`t=${t},v1=${sign(rawBody)}`, rawBody, { ok: true }],
      [`t=${t},v1=${sign(rawBody)}`, reserialised, { ok: false, reason: 'mismatch' }], // same JSON, different bytes
      [`t=${t - 301},v1=${sign(rawBody, t - 301)}`, rawBody, { ok: false, reason: 'stale' }], // a replay from > 5 min ago
      [`t=${t},v1=${'z'.repeat(64)}`, rawBody, { ok: false, reason: 'malformed' }],
      [undefined, rawBody, { ok: false, reason: 'missing' }],
    ];
    for (const [header, body, expected] of cases) assert.deepEqual(verifySignature({ header, rawBody: body, secret, now }), expected, String(header));
  });
});
