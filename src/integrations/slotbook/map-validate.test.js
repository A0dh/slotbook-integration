import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createMapper } from './map.js';
import { createValidator } from './validate.js';

const sample = JSON.parse(readFileSync(new URL('../../../data/slotbook/webhooks/02-under-18-with-guardian.json', import.meta.url), 'utf8'));
const map = createMapper({ rules: [] });
const validate = createValidator({ now: () => Date.UTC(2026, 10, 24) });

/** The under-18 sample webhook with one climber detail changed. */
function problemsWith(change) {
  const event = structuredClone(sample);
  Object.assign(event.data.climber, change);
  return validate(map({ kind: 'webhook', event }));
}

describe('SlotBook validation', () => {
  it('rejects what is unsafe to store or would let a child skip the guardian rule', () => {
    const cases = [
      [{}, []],
      [{ email: 'evie.okafor@' }, ['email_invalid']],
      [{ dateOfBirth: '1902-01-01' }, ['date_of_birth_implausible']], // placeholder: would make a child an adult
      [{ dateOfBirth: '2031-07-04' }, ['date_of_birth_in_future']],
      [{ guardian: { name: 'N/A', phone: 'N/A' } }, []], // dropped and flagged; the sender then needs another guardian
      [{ email: '=HYPERLINK("http://x")@example.com' }, ['email_invalid']],
      [{ firstName: "=cmd|' /C calc'!A0" }, ['first_name_invalid']], // spreadsheet formula
    ];
    for (const [change, expected] of cases) assert.deepEqual(problemsWith(change), expected, JSON.stringify(change));
  });
});
