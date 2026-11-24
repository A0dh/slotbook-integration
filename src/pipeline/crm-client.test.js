import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CrmError, RETRY_POLICY, createCrmClient } from './crm-client.js';

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A client whose fetch replays `responses` in order and whose waits are recorded, not slept. */
function clientWith(responses) {
  const calls = [];
  const waits = [];
  const crm = createCrmClient({
    baseUrl: 'http://crm.test',
    apiKey: 'key',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return responses.shift();
    },
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  return { crm, calls, waits };
}

const ok = () => json(200, { results: [{ index: 0, status: 201, id: 'mem_1', created: true }] });

describe('CRM client batch and lookup methods', () => {
  it('waits for Retry-After on 429, then succeeds', async () => {
    const { crm, waits } = clientWith([json(429, {}, { 'retry-after': '2' }), ok()]);
    const results = await crm.upsertMembers([{ email: 'a@example.com' }]);
    assert.deepEqual(waits, [2000]);
    assert.equal(results[0].id, 'mem_1');
  });

  it('gives up after the configured number of attempts', async () => {
    const responses = Array.from({ length: RETRY_POLICY.attempts }, () => json(503, {}));
    const { crm, calls, waits } = clientWith(responses);
    await assert.rejects(crm.createBookings([{}]), (err) => err instanceof CrmError && err.status === 503);
    assert.equal(calls.length, RETRY_POLICY.attempts);
    assert.equal(waits.length, RETRY_POLICY.attempts - 1, 'backs off between attempts');
  });
});
