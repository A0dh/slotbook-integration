import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger } from '../lib/logger.js';
import { runPipeline } from './run.js';

const logger = createLogger('error', () => {});

describe('runPipeline', () => {
  it('imports, rejects and records failures per record', async () => {
    const sent = [];
    const integration = {
      source: 'test',
      refOf: (raw) => raw.id,
      map: (raw) => {
        if (raw.id === 'unmappable') throw new Error('bad shape');
        return { ...raw };
      },
      validate: (mapped) => (mapped.ok ? [] : ['not ok']),
      async send(mapped) {
        if (mapped.id === 'flaky') throw new Error('CRM responded 500');
        sent.push(mapped.id);
      },
    };

    const summary = await runPipeline(
      [{ id: 'a', ok: true }, { id: 'b', ok: false }, { id: 'unmappable' }, { id: 'flaky', ok: true }],
      integration,
      { logger },
    );

    assert.deepEqual(sent, ['a']);
    assert.equal(summary.imported, 1);
    assert.deepEqual(summary.rejected, [
      { ref: 'b', reasons: ['not ok'] },
      { ref: 'unmappable', reasons: ['Could not map record: bad shape'] },
    ]);
    assert.deepEqual(summary.failed, [{ ref: 'flaky', error: 'CRM responded 500' }]);
    assert.equal(summary.total, 4);
  });
});
