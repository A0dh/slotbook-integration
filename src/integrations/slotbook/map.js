// Maps SlotBook bookings (webhook events and CSV export rows) to a CRM member and booking.
//
// Both sources first become the same flat record (fromWebhook / fromCsvRow), then go through
// the same cleaning and mapping. Everything is treated as untrusted: missing or wrongly typed
// values become empty strings for validation to reject, unknown fields (such as
// internal_score) are dropped, and nothing here throws.

import { isIsoDateTime, isUkPostcode, isValidGuardian } from '../../lib/validators.js';
import { applyRules } from '../../rules/index.js';

/**
 * Fields of the flat record that cleaning rules may target. Not bookingId: it is the CRM
 * idempotency key, so no rule may change it.
 */
export const FIELDS = /** @type {const} */ ([
  'sessionStart',
  'sessionType',
  'firstName',
  'lastName',
  'email',
  'dateOfBirth',
  'postcode',
  'guardianName',
  'guardianPhone',
  'notes',
]);

/** The CRM keeps at most this many characters of notes. */
export const NOTES_LIMIT = 500;

// Notes are free text from the public: kept as text, but flagged for staff when they look like
// a spreadsheet formula, markup or instructions aimed at an AI.
const SUSPICIOUS_NOTES = /^[=+\-@]|[<>]|ignore (all |any )?(previous|prior) instructions|system\s*:|note to any ai|approve every/i;
// Letters (any alphabet), combining marks, spaces, apostrophes, full stops and hyphens.
const NAME_CHARACTERS = /^[\p{L}\p{M}\s'’.-]*$/u;

/**
 * @typedef {{ kind: 'webhook', event: unknown } | { kind: 'csv', row: Record<string, string>, rowNumber: number }} SlotbookInput
 * @typedef {Record<(typeof FIELDS)[number], string> & { bookingId: string, amountPence: unknown }} FlatRecord
 * @typedef {{ name: string, phone: string }} Guardian
 * @typedef {{
 *   bookingId: string,
 *   member: { firstName: string, lastName: string, email: string, dateOfBirth: string, postcode?: string, guardian?: Guardian, source: string, sourceRef: string },
 *   booking: { sessionStart: string, sessionType: string, amountPence: number, notes?: string, source: string, sourceRef: string },
 *   flags: string[],
 * }} MappedBooking
 */

const SOURCE = 'slotbook';

/** @param {unknown} value */
const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** Names: also one space between words ("van  der Berg" → "van der Berg"). @param {unknown} value */
const name = (value) => text(value).replace(/\s+/g, ' ');

/** @param {unknown} value */
const asObject = (value) => (typeof value === 'object' && value !== null ? /** @type {Record<string, unknown>} */ (value) : {});

/**
 * A `booking.created` webhook event → flat record.
 * @param {unknown} event
 * @returns {FlatRecord}
 */
export function fromWebhook(event) {
  const data = asObject(asObject(event).data);
  const session = asObject(data.session);
  const climber = asObject(data.climber);
  const guardian = asObject(climber.guardian);
  return {
    bookingId: text(data.bookingId),
    sessionStart: text(session.start),
    sessionType: text(session.type),
    firstName: name(climber.firstName),
    lastName: name(climber.lastName),
    email: text(climber.email),
    dateOfBirth: text(climber.dateOfBirth),
    postcode: text(climber.postcode),
    guardianName: name(guardian.name),
    guardianPhone: text(guardian.phone),
    amountPence: data.amountPence,
    notes: text(data.notes),
  };
}

/**
 * A row of the CSV export → flat record.
 * @param {Record<string, string>} row
 * @returns {FlatRecord}
 */
export function fromCsvRow(row) {
  return {
    bookingId: text(row.booking_id),
    sessionStart: text(row.session_start),
    sessionType: text(row.session_type),
    firstName: name(row.first_name),
    lastName: name(row.last_name),
    email: text(row.email),
    dateOfBirth: text(row.date_of_birth),
    postcode: text(row.postcode),
    guardianName: name(row.guardian_name),
    guardianPhone: text(row.guardian_phone),
    amountPence: text(row.amount_pence),
    notes: text(row.notes),
  };
}

/**
 * @param {{ rules: import('../../rules/index.js').Rule[], onRuleApplied?: (rule: string) => void }} deps
 * @returns {(input: SlotbookInput) => MappedBooking}
 */
export function createMapper({ rules, onRuleApplied }) {
  return function map(input) {
    const flat = input.kind === 'webhook' ? fromWebhook(input.event) : fromCsvRow(input.row);
    const r = applyRules(flat, rules, onRuleApplied);
    /** @type {string[]} */
    const flags = [];

    // Postcode is optional: one we can't make valid is dropped rather than losing the booking.
    let postcode = r.postcode || undefined;
    if (postcode && !isUkPostcode(postcode)) {
      postcode = undefined;
      flags.push('postcode_dropped');
    }

    let notes = r.notes || undefined;
    if (notes && SUSPICIOUS_NOTES.test(notes)) flags.push('notes_suspicious');
    if (notes && notes.length > NOTES_LIMIT) {
      notes = notes.slice(0, NOTES_LIMIT).replace(/[\uD800-\uDBFF]$/, ''); // don't split an emoji in two
      flags.push('notes_truncated');
    }

    // A guardian nobody could contact ("N/A", no phone) is dropped like a bad postcode. Adults
    // don't need one; for an under-18 the sender then looks for a usable one or rejects.
    let guardian = r.guardianName || r.guardianPhone ? { name: r.guardianName, phone: r.guardianPhone } : undefined;
    if (guardian && !isValidGuardian(guardian)) {
      guardian = undefined;
      flags.push('guardian_dropped');
    }

    if (![r.firstName, r.lastName, guardian?.name ?? ''].every((name) => NAME_CHARACTERS.test(name))) flags.push('name_unusual');

    return {
      bookingId: r.bookingId,
      // Key order is fixed: the CRM compares retried bookings byte for byte.
      member: {
        firstName: r.firstName,
        lastName: r.lastName,
        // Email is how the CRM recognises a member, and its match is case-sensitive. Lower-casing
        // is identity policy, not an optional cleaning rule.
        email: r.email.toLowerCase(),
        dateOfBirth: r.dateOfBirth,
        ...(postcode && { postcode }),
        ...(guardian && { guardian }),
        source: SOURCE,
        sourceRef: r.bookingId,
      },
      booking: {
        sessionStart: canonicalDateTime(r.sessionStart),
        sessionType: r.sessionType,
        amountPence: toPence(r.amountPence),
        ...(notes && { notes }),
        source: SOURCE,
        sourceRef: r.bookingId,
      },
      flags,
    };
  };
}

/**
 * One spelling per instant (`2024-03-04T16:00:00Z`), so a webhook and an export row for the same
 * booking produce identical CRM requests. Invalid values are passed through for validation.
 * @param {string} value
 */
function canonicalDateTime(value) {
  return isIsoDateTime(value) ? new Date(value).toISOString().replace('.000Z', 'Z') : value;
}

/**
 * Whole pence from a JSON number or a CSV string; anything else becomes NaN for validation.
 * @param {unknown} value
 */
function toPence(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\d{1,9}$/.test(value)) return Number(value);
  return Number.NaN;
}
