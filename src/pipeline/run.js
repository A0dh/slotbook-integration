// The shared integration pipeline: map → validate → send. Records are mapped and validated
// one at a time, then sent one at a time (send) or in chunks (sendBatch).
//
// Each integration supplies four functions (see src/integrations/*):
//   refOf(raw)       a reference for the record, used in the run summary
//   map(raw)         source record → our shape for the CRM (may throw)
//   validate(mapped) → list of problems; empty means valid
//   send(mapped)     sends the record to the CRM
//
// Optionally, instead of send:
//   sendBatch(mapped[]) sends valid records in chunks (for large imports) and
//                       returns one SendOutcome per record, in the same order

import { RunSummary } from './summary.js';

const DEFAULT_BATCH_SIZE = 100;

/**
 * @typedef {object} Integration
 * @property {string} source
 * @property {(raw: any) => string} refOf
 * @property {(raw: any) => any} map
 * @property {(mapped: any) => string[]} validate
 * @property {(mapped: any) => Promise<void>} [send]
 * @property {(mapped: any[]) => Promise<SendOutcome[]>} [sendBatch]
 * @property {number} [batchSize] records per sendBatch call (default 100)
 */

/**
 * What happened to one record sent with sendBatch.
 * @typedef {{ status: 'imported' } | { status: 'rejected', reasons: string[] } | { status: 'failed', error: string }} SendOutcome
 */

/**
 * @param {Iterable<any> | AsyncIterable<any>} records
 * @param {Integration} integration
 * @param {{ logger: import('../lib/logger.js').Logger, summary?: RunSummary }} deps
 *   pass `summary` when the integration needs to add flags or rule counts to it while running
 * @returns {Promise<RunSummary>}
 */
export async function runPipeline(records, integration, { logger, summary = new RunSummary(integration.source) }) {
  /** @type {{ ref: string, mapped: any }[]} */
  const pending = [];
  const batchSize = integration.batchSize ?? DEFAULT_BATCH_SIZE;
  const flush = () => sendPending(pending.splice(0), integration, summary, logger);

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

    if (integration.sendBatch) {
      pending.push({ ref, mapped });
      if (pending.length >= batchSize) await flush();
      continue;
    }

    try {
      await /** @type {NonNullable<Integration['send']>} */ (integration.send)(mapped);
      summary.recordImported();
    } catch (err) {
      logger.warn('Sending record failed', { source: integration.source, ref, error: err.message });
      summary.recordFailed(ref, err.message);
    }
  }

  await flush();
  return summary.finish();
}

/**
 * Sends one chunk and records an outcome for every record in it. If the whole call throws,
 * every record in the chunk failed; if one outcome is missing, only that record failed.
 * @param {{ ref: string, mapped: any }[]} chunk
 * @param {Integration} integration
 * @param {RunSummary} summary
 * @param {import('../lib/logger.js').Logger} logger
 */
async function sendPending(chunk, integration, summary, logger) {
  if (chunk.length === 0) return;

  /** @type {(SendOutcome | undefined)[]} */
  let outcomes;
  try {
    outcomes = await /** @type {NonNullable<Integration['sendBatch']>} */ (integration.sendBatch)(chunk.map((item) => item.mapped));
  } catch (err) {
    logger.warn('Sending batch failed', { source: integration.source, records: chunk.length, error: err.message });
    for (const { ref } of chunk) summary.recordFailed(ref, err.message);
    return;
  }

  chunk.forEach(({ ref }, i) => {
    const outcome = outcomes[i];
    if (outcome?.status === 'imported') summary.recordImported();
    else if (outcome?.status === 'rejected') summary.recordRejected(ref, outcome.reasons);
    else if (outcome?.status === 'failed') summary.recordFailed(ref, outcome.error);
    else summary.recordFailed(ref, 'No result from sender');
  });
}
