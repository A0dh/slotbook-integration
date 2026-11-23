// The shared integration pipeline: map → validate → send, one record at a time.
//
// Each integration supplies four functions (see src/integrations/*):
//   refOf(raw)       a reference for the record, used in the run summary
//   map(raw)         source record → our shape for the CRM (may throw)
//   validate(mapped) → list of problems; empty means valid
//   send(mapped)     sends the record to the CRM

import { RunSummary } from './summary.js';

/**
 * @typedef {object} Integration
 * @property {string} source
 * @property {(raw: any) => string} refOf
 * @property {(raw: any) => any} map
 * @property {(mapped: any) => string[]} validate
 * @property {(mapped: any) => Promise<void>} send
 */

/**
 * @param {Iterable<any> | AsyncIterable<any>} records
 * @param {Integration} integration
 * @param {{ logger: import('../lib/logger.js').Logger }} deps
 * @returns {Promise<RunSummary>}
 */
export async function runPipeline(records, integration, { logger }) {
  const summary = new RunSummary(integration.source);

  for await (const raw of records) {
    const ref = integration.refOf(raw);

    let mapped;
    try {
      mapped = integration.map(raw);
    } catch (err) {
      summary.recordRejected(ref, [`Could not map record: ${err.message}`]);
      continue;
    }

    const problems = integration.validate(mapped);
    if (problems.length > 0) {
      summary.recordRejected(ref, problems);
      continue;
    }

    try {
      await integration.send(mapped);
      summary.recordImported();
    } catch (err) {
      logger.warn('Sending record failed', { source: integration.source, ref, error: err.message });
      summary.recordFailed(ref, err.message);
    }
  }

  return summary.finish();
}
