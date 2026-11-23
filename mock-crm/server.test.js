import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createMockCrm } from './server.js';

const API_KEY = 'test-key';
let baseUrl;
let server;

before(async () => {
  server = createServer(createMockCrm({ apiKey: API_KEY, chaos: false }));
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function post(path, body, headers = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

const member = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  dateOfBirth: '1990-12-10',
  postcode: 'LS6 2AB',
  source: 'test',
};

describe('mock CRM', () => {
  it('rejects requests without the API key', async () => {
    const res = await fetch(`${baseUrl}/members`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
  });

  it('creates a member, then matches the same email', async () => {
    const first = await post('/members', member);
    assert.equal(first.status, 201);
    assert.equal(first.body.created, true);

    const second = await post('/members', member);
    assert.equal(second.status, 200);
    assert.equal(second.body.id, first.body.id);
  });

  it('rejects unformatted postcodes and unknown fields', async () => {
    const res = await post('/members', { ...member, email: 'b@example.com', postcode: 'ls62ab', shoeSize: 7 });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.fields.postcode);
    assert.ok(res.body.error.fields._unknown);
  });

  it('replays a booking with the same idempotency key', async () => {
    const { body: m } = await post('/members', member);
    const booking = {
      memberId: m.id,
      sessionStart: '2026-01-10T18:00:00Z',
      sessionType: 'bouldering',
      amountPence: 1250,
      source: 'test',
    };
    const first = await post('/bookings', booking, { 'idempotency-key': 'SB-1' });
    const second = await post('/bookings', booking, { 'idempotency-key': 'SB-1' });
    assert.equal(first.status, 201);
    assert.equal(second.body.id, first.body.id);
    assert.equal(second.headers.get('idempotent-replayed'), 'true');

    const conflict = await post('/bookings', { ...booking, amountPence: 999 }, { 'idempotency-key': 'SB-1' });
    assert.equal(conflict.status, 409);
  });

  it('rejects impossible session dates that Date.parse would roll over', async () => {
    const { body: m } = await post('/members', member);
    const res = await post('/bookings', {
      memberId: m.id,
      sessionStart: '2025-02-29T18:00:00Z',
      sessionType: 'bouldering',
      amountPence: 1250,
      source: 'test',
    });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.fields.sessionStart);
  });

  it('reports per-item results for batches', async () => {
    const res = await post('/members/batch', {
      members: [{ ...member, email: 'c@example.com' }, { ...member, email: 'not-an-email' }],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.results[0].status, 201);
    assert.equal(res.body.results[1].status, 422);
  });
});
