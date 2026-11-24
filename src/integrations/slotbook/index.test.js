import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createLogger } from '../../lib/logger.js';
import { createMockCrm } from '../../../mock-crm/server.js';
import { createCrmClient } from '../../pipeline/crm-client.js';
import { slotbookWebhookHandler } from './index.js';

const secret = 'test-secret';
const logger = createLogger('error', () => {});
const dir = mkdtempSync(join(tmpdir(), 'slotbook-'));
const rulesPath = join(dir, 'rules.json');
const logPath = join(dir, 'webhooks.jsonl');
writeFileSync(rulesPath, JSON.stringify({ rules: [{ field: 'firstName', op: 'title_case' }, { field: 'lastName', op: 'title_case' }, { field: 'postcode', op: 'uk_postcode' }] }));

const webhooksDir = new URL('../../../data/slotbook/webhooks/', import.meta.url);
const sample = (file) => readFileSync(new URL(file, webhooksDir), 'utf8');

/** Mock CRM (no chaos) + the SlotBook handler, each on its own port. */
let crmServer;
let appServer;
let appUrl;
let crmUrl;

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler).listen(0, () => resolve(server));
  });
}

before(async () => {
  crmServer = await listen(createMockCrm({ apiKey: 'k', chaos: false }));
  crmUrl = `http://localhost:${crmServer.address().port}`;
  const crm = createCrmClient({ baseUrl: crmUrl, apiKey: 'k' });
  const handler = slotbookWebhookHandler({ crm, logger, webhookSecret: () => secret, rulesPath, logPath });
  appServer = await listen((req, res) =>
    handler(req, res).catch((err) => {
      res.writeHead(err.status ?? 500);
      res.end(err.message);
    }),
  );
  appUrl = `http://localhost:${appServer.address().port}`;
});

after(() => {
  appServer.close();
  crmServer.close();
});

function post(body, { sign = true, url = appUrl } = {}) {
  const t = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return fetch(url, { method: 'POST', body, headers: sign ? { 'slotbook-signature': `t=${t},v1=${signature}` } : {} });
}

const stats = async () => (await fetch(`${crmUrl}/stats`, { headers: { 'x-api-key': 'k' } })).json();

describe('SlotBook webhook endpoint', () => {
  it('handles each sample webhook as predicted', async () => {
    const outcomes = {};
    for (const file of readdirSync(webhooksDir).sort()) {
      const res = await post(sample(file));
      outcomes[file] = `${res.status} ${(await res.json()).status}`;
    }
    assert.deepEqual(outcomes, {
      '01-adult.json': '200 imported',
      '02-under-18-with-guardian.json': '200 imported',
      '03-booking.json': '200 imported', // names and postcode cleaned
      '04-booking.json': '200 rejected', // under 18, no guardian
      '05-booking.json': '200 imported', // AI-directed notes kept as text, flagged
      '06-booking.json': '200 imported', // redelivery of 02: replayed, nothing new created
      '07-booking.json': '200 imported', // Jane again, different email case: same member
      '08-booking.json': '200 rejected', // invalid email
    });
    const { members, bookings, idempotentReplays } = await stats();
    assert.equal(bookings, 5, '06 is a redelivery of 02');
    assert.equal(idempotentReplays, 1);
    assert.equal(members, 4, '01 and 07 are the same person; 04 and 08 never reach the CRM');

    // Whole entries (bar the time): refs and codes only, no personal data.
    const log = readFileSync(logPath, 'utf8').trim().split('\n').map((line) => {
      const { at, ...entry } = JSON.parse(line);
      return entry;
    });
    assert.deepEqual(log, [
      { ref: 'SB-150004', status: 'rejected', reasons: ['guardian_required'], flags: [] },
      { ref: 'SB-150005', status: 'imported', flags: ['notes_suspicious'] },
      { ref: 'SB-150008', status: 'rejected', reasons: ['email_invalid'], flags: [] },
    ]);
  });

  it('refuses unsigned webhooks, and asks SlotBook to retry when the CRM is down', async () => {
    assert.equal((await post(sample('01-adult.json'), { sign: false })).status, 401);

    const crmDown = { findMemberByEmail: async () => Promise.reject(new Error('CRM unreachable')) };
    const handler = slotbookWebhookHandler({ crm: crmDown, logger, webhookSecret: () => secret, rulesPath, logPath });
    const server = await listen((req, res) => handler(req, res));
    try {
      const res = await post(sample('01-adult.json'), { url: `http://localhost:${server.address().port}` });
      assert.deepEqual([res.status, (await res.json()).status], [503, 'failed']);
    } finally {
      server.close();
    }
  });
});
