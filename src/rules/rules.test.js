import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OPERATIONS } from './index.js';

const op = (name, value, rule = {}) => OPERATIONS[name].apply(value, { field: 'x', op: name, ...rule });

describe('cleaning operations', () => {
  it('converts day-first UK dates and UK local times to ISO', () => {
    const dateTime = { format: 'DD/MM/YYYY HH:mm' };
    assert.equal(op('uk_date', '01/01/2024 17:30', dateTime), '2024-01-01T17:30:00Z', 'GMT');
    assert.equal(op('uk_date', '01/04/2024 10:00', dateTime), '2024-04-01T09:00:00Z', 'BST is an hour ahead');
    assert.equal(op('uk_date', '08/09/2012', { format: 'DD/MM/YYYY' }), '2012-09-08', 'day first, not month first');
    assert.equal(op('uk_date', '29/02/2023 10:00', dateTime), '29/02/2023 10:00', 'impossible dates are left for validation');
    assert.equal(op('uk_date', '04/03/2024 25:00', dateTime), '04/03/2024 25:00', 'and impossible times');
    assert.equal(op('uk_date', '2024-03-04T16:00:00Z', dateTime), '2024-03-04T16:00:00Z', 'ISO values are left alone');
  });
});
