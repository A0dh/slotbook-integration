import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCsv } from './csv.js';

describe('parseCsv', () => {
  it('maps rows to objects using the header', () => {
    assert.deepEqual(parseCsv('a,b\n1,2\n3,4\n'), [
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('handles quotes, escaped quotes, commas and newlines inside fields', () => {
    const rows = parseCsv('name,note\r\n"Smith, Jo","said ""hi""\nthen left"\r\n');
    assert.deepEqual(rows, [{ name: 'Smith, Jo', note: 'said "hi"\nthen left' }]);
  });

  it('fills missing trailing fields with empty strings', () => {
    assert.deepEqual(parseCsv('a,b,c\n1'), [{ a: '1', b: '', c: '' }]);
  });
});
