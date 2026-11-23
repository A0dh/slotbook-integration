import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapWaiver } from './map.js';
import { validateWaiver } from './validate.js';

const row = {
  waiver_id: 'W-1001',
  signed_at: '2026-11-01T10:00:00Z',
  full_name: 'Mary Anne Jones',
  email: ' mary@example.com ',
  date_of_birth: '1992-04-03',
  postcode: 'ls6 2ab',
  phone: '',
};

describe('front-desk waivers', () => {
  it('maps a waiver row to a CRM member', () => {
    assert.deepEqual(mapWaiver(row), {
      firstName: 'Mary Anne',
      lastName: 'Jones',
      email: 'mary@example.com',
      dateOfBirth: '1992-04-03',
      postcode: 'LS6 2AB',
      phone: undefined,
      source: 'front-desk-waivers',
      sourceRef: 'W-1001',
    });
  });

  it('throws when there is no surname', () => {
    assert.throws(() => mapWaiver({ ...row, full_name: 'Cher' }), /no surname/);
  });

  it('accepts a valid member and reports each problem', () => {
    assert.deepEqual(validateWaiver(mapWaiver(row)), []);
    const problems = validateWaiver({ ...mapWaiver(row), email: 'nope', dateOfBirth: '03/04/1992' });
    assert.deepEqual(problems, ['Email address is not valid', 'Date of birth is not YYYY-MM-DD']);
  });
});
