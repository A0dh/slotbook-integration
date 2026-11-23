import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSender, decideMember } from './sender.js';

const guardian = { name: 'Chidi Okafor', phone: '+447700900412' };

/** A mapped booking; `minor` makes the climber 12 at the session. */
function booking(bookingId, { email = `${bookingId}@example.com`, minor = false, withGuardian = minor, flags = [] } = {}) {
  return {
    bookingId,
    member: {
      firstName: 'Evie',
      lastName: 'Okafor',
      email,
      dateOfBirth: minor ? '2014-01-01' : '1980-01-01',
      ...(withGuardian && { guardian }),
      source: 'slotbook',
      sourceRef: bookingId,
    },
    booking: { sessionStart: '2026-12-01T18:00:00Z', sessionType: 'course', amountPence: 4500, source: 'slotbook', sourceRef: bookingId },
    flags,
  };
}

/** Just enough CRM: members by email, bookings by idempotency key. */
function fakeCrm({ existing = [] } = {}) {
  const members = new Map(existing.map((m, n) => [m.email, { id: `mem_old${n}`, ...m }]));
  const bookings = new Map();
  const calls = { lookups: 0, memberBatches: [], bookingBatches: [] };
  return {
    calls,
    members,
    bookings,
    async findMemberByEmail(email) {
      calls.lookups++;
      return members.get(email) ?? null;
    },
    async upsertMembers(batch) {
      calls.memberBatches.push(batch);
      return batch.map((m, index) => {
        if (!members.has(m.email)) members.set(m.email, { id: `mem_${members.size}`, ...m });
        return { index, status: 201, id: members.get(m.email).id, created: true };
      });
    },
    async createBookings(batch) {
      calls.bookingBatches.push(batch);
      return batch.map(({ idempotencyKey, ...b }, index) => {
        const previous = bookings.get(idempotencyKey);
        if (previous && JSON.stringify(previous) !== JSON.stringify(b)) return { index, status: 409, error: { code: 'idempotency_conflict' } };
        bookings.set(idempotencyKey, b);
        return { index, status: 201, id: `bkg_${idempotencyKey}` };
      });
    },
  };
}

function setup(crmOptions) {
  const crm = fakeCrm(crmOptions);
  const send = createSender({ crm, summary: { flag() {} } });
  return { crm, send };
}

describe('decideMember', () => {
  const minor = booking('SB-2', { minor: true });
  const minorAlone = booking('SB-3', { minor: true, withGuardian: false });

  it('requires a guardian on the CRM record an under-18 booking lands on', () => {
    assert.ok(decideMember(minorAlone, { dateOfBirth: '2014-01-01', guardian }, undefined).ok, 'already on record');
    assert.deepEqual(decideMember(minor, { dateOfBirth: '2014-01-01' }, undefined), { ok: false, reason: 'guardian_not_on_crm_record' });
    assert.deepEqual(decideMember(minorAlone, null, undefined), { ok: false, reason: 'guardian_required' });
    assert.deepEqual(decideMember(minorAlone, null, guardian), { ok: true, guardian, recovered: true });
  });
});

describe('SlotBook sender', () => {
  it('creates members and bookings, keyed so a re-send creates nothing new', async () => {
    const { crm, send } = setup();
    const items = [booking('SB-1'), booking('SB-2', { minor: true })];
    assert.deepEqual(await send(items), [{ status: 'imported' }, { status: 'imported' }]);
    assert.equal(crm.calls.bookingBatches[0][0].idempotencyKey, 'slotbook:SB-1');
    assert.deepEqual(crm.members.get('SB-2@example.com').guardian, guardian);

    // A second run (new sender, same CRM): members are found, bookings replay.
    const again = createSender({ crm, summary: { flag() {} } });
    assert.deepEqual(await again(items), [{ status: 'imported' }, { status: 'imported' }]);
    assert.equal(crm.bookings.size, 2);
  });

  it('rejects a child booked under an adult already in the CRM', async () => {
    const { send } = setup({ existing: [{ email: 'evie.okafor@example.org', dateOfBirth: '1961-05-05' }] });
    const outcomes = await send([booking('SB-150002', { email: 'evie.okafor@example.org', minor: true })]);
    assert.deepEqual(outcomes, [{ status: 'rejected', reasons: ['identity_conflict'] }]);
  });

});
