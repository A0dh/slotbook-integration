// SlotBook: Bramble Wall's booking app. Each booking becomes a CRM member (created or matched
// by email) and a booking. Two ways in, one pipeline:
//
//   POST /webhooks/slotbook                       live bookings, signed by SlotBook
//   npm run import -- slotbook <export.csv>       historical bookings from SlotBook's export
//
// Docs: docs/slotbook.md. Cleaning rules: config/rules/slotbook.json (see npm run rules:suggest).

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../../lib/csv.js';
import { HttpError, parseJsonBody, readBody, sendJson } from '../../lib/http.js';
import { runPipeline } from '../../pipeline/run.js';
import { RunSummary } from '../../pipeline/summary.js';
import { loadRuleSet } from '../../rules/index.js';
import { FIELDS, createMapper } from './map.js';
import { createSender } from './sender.js';
import { verifySignature } from './signature.js';
import { createValidator, isSafeId } from './validate.js';

// Relative to the repository, not to wherever the app was started from.
const fromRepo = (path) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
export const RULES_PATH = fromRepo('config/rules/slotbook.json');
export const WEBHOOK_LOG_PATH = fromRepo('out/slotbook-webhooks.jsonl');
/** SlotBook waits 10 s for an answer; leave time to send it. */
const WEBHOOK_DEADLINE_MS = 8000;
/** The largest real webhook is ~11 KB (notes are capped at 10,000 characters). */
const WEBHOOK_MAX_BYTES = 256 * 1024;

/**
 * @typedef {import('../../pipeline/crm-client.js').CrmClient} CrmClient
 * @typedef {import('../../lib/logger.js').Logger} Logger
 * @typedef {import('./map.js').SlotbookInput} SlotbookInput
 */

/**
 * A reference safe to show staff and write to logs: the booking id when it looks like one,
 * otherwise where the record came from. Never throws.
 * @param {SlotbookInput} input
 */
export function refOf(input) {
  if (input.kind === 'csv') return isSafeId(input.row?.booking_id) ? input.row.booking_id : `row ${input.rowNumber}`;
  const event = /** @type {any} */ (input.event);
  if (isSafeId(event?.data?.bookingId)) return event.data.bookingId;
  return isSafeId(event?.id) ? `event ${event.id}` : 'event (no id)';
}

/**
 * One SlotBook run (a webhook or an import): the integration and the summary it reports into.
 * @param {{
 *   crm: CrmClient,
 *   rules: import('../../rules/index.js').Rule[],
 *   guardianFor?: (email: string, dateOfBirth: string) => import('./map.js').Guardian | undefined,
 *   signal?: AbortSignal,
 *   now?: () => number,
 * }} deps
 */
export function createSlotbookRun({ crm, rules, guardianFor, signal, now }) {
  const summary = new RunSummary('slotbook');
  /** @type {import('../../pipeline/run.js').Integration} */
  const integration = {
    source: 'slotbook',
    refOf,
    map: createMapper({ rules, onRuleApplied: (rule) => summary.countRule(rule) }),
    validate: createValidator({ now }),
    sendBatch: createSender({ crm, summary, guardianFor, signal }),
  };
  return { integration, summary };
}

/**
 * HTTP handler for SlotBook webhooks.
 *
 * Answers 200 once a booking is imported, a duplicate, or rejected for its data (retrying
 * won't fix data, so rejections are logged for staff instead). Answers 503 when the CRM could
 * not take it in time, so SlotBook retries; idempotency keys make that safe.
 *
 * @param {{
 *   crm: CrmClient,
 *   logger: Logger,
 *   webhookSecret: () => string,
 *   rulesPath?: string,
 *   logPath?: string,
 *   now?: () => number,
 * }} deps
 */
export function slotbookWebhookHandler({ crm, logger, webhookSecret, rulesPath = RULES_PATH, logPath = WEBHOOK_LOG_PATH, now = Date.now }) {
  return async (req, res) => {
    const rawBody = await readBody(req, WEBHOOK_MAX_BYTES);
    const signature = verifySignature({ header: req.headers['slotbook-signature'], rawBody, secret: webhookSecret(), now: now() });
    if (!signature.ok) {
      logger.warn('SlotBook webhook refused', { reason: signature.reason });
      throw new HttpError(401, 'Invalid signature');
    }

    const event = parseJsonBody(rawBody);
    if (event?.type !== 'booking.created') return sendJson(res, 200, { status: 'ignored' });

    const { rules, missing } = loadRuleSet(rulesPath, FIELDS);
    if (missing) logger.warn('No approved cleaning rules yet; webhook not cleaned', { rulesPath });
    const { integration, summary } = createSlotbookRun({ crm, rules, signal: AbortSignal.timeout(WEBHOOK_DEADLINE_MS), now });
    await runPipeline([{ kind: 'webhook', event }], integration, { logger, summary });

    const ref = refOf({ kind: 'webhook', event });
    if (summary.failed.length > 0) {
      logger.warn('SlotBook webhook not delivered to the CRM', { ref, error: summary.failed[0].error });
      return sendJson(res, 503, { status: 'failed' });
    }

    const reasons = summary.rejected[0]?.reasons;
    const flags = summary.flagged.map((f) => f.code);
    // Written before we answer: if it can't be, the 500 makes SlotBook send it again.
    if (reasons || flags.length > 0) appendLine(logPath, { at: new Date(now()).toISOString(), ref, status: reasons ? 'rejected' : 'imported', reasons, flags });
    if (reasons) {
      logger.info('SlotBook webhook rejected', { ref, reasons });
      return sendJson(res, 200, { status: 'rejected', reasons });
    }
    return sendJson(res, 200, { status: 'imported' });
  };
}

/**
 * Imports a SlotBook CSV export through the same pipeline as webhooks.
 * @param {string} filePath
 * @param {{ crm: CrmClient, logger: Logger, rulesPath?: string }} deps
 */
export async function importSlotbookFile(filePath, { crm, logger, rulesPath = RULES_PATH }) {
  const { rules, missing } = loadRuleSet(rulesPath, FIELDS);
  if (missing) logger.warn('No approved cleaning rules yet; importing without cleaning', { rulesPath });

  /** @type {SlotbookInput[]} */
  const inputs = parseCsv(readFileSync(filePath, 'utf8')).map((row, i) => ({ kind: 'csv', row, rowNumber: i + 1 }));
  const { integration, summary } = createSlotbookRun({ crm, rules, guardianFor: guardianIndex(inputs, rules) });
  return runPipeline(inputs, integration, { logger, summary });
}

/**
 * Guardians given anywhere in the file, by climber (email + date of birth), so a booking where
 * a climber left the guardian out can use the one they gave on another booking.
 * @param {SlotbookInput[]} inputs
 * @param {import('../../rules/index.js').Rule[]} rules
 */
function guardianIndex(inputs, rules) {
  const map = createMapper({ rules });
  const validate = createValidator();
  const index = new Map();
  for (const input of inputs) {
    const mapped = map(input);
    if (mapped.member.guardian && validate(mapped).length === 0) index.set(`${mapped.member.email}|${mapped.member.dateOfBirth}`, mapped.member.guardian);
  }
  return (email, dateOfBirth) => index.get(`${email}|${dateOfBirth}`);
}

/**
 * @param {string} path
 * @param {object} entry no personal data: refs, statuses and codes only
 */
function appendLine(path, entry) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}
