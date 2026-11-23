// Checks a mapped SlotBook booking before it goes to the CRM. These rules are code, not
// configuration: no approved rule set can relax them.
//
// Rejected means the record is unsafe to store or the CRM would refuse it. Doubtful but usable
// records are imported and flagged instead (see map.js). Whether an under-18 has a guardian
// contact on record depends on what the CRM already holds, so the sender decides that.

import { ageOn, hasUnsafeText, isCalendarDate, isEmail, isIsoDateTime } from '../../lib/validators.js';

/** Climbers younger than this at the session must have a guardian contact on record. */
export const GUARDIAN_AGE = 18;
/** Older than this at the session is taken to be a placeholder date of birth (e.g. 1900-01-01). */
export const MAX_AGE = 100;
export const SESSION_TYPES = ['bouldering', 'top-rope', 'lead', 'course', 'other'];

// Booking ids are also the CRM idempotency key and appear in logs, so kept to a safe alphabet.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** @param {unknown} value */
export const isSafeId = (value) => typeof value === 'string' && SAFE_ID.test(value);

/**
 * @param {string} dateOfBirth valid `YYYY-MM-DD`
 * @param {string} sessionStart valid ISO date-time
 */
export const isMinorAt = (dateOfBirth, sessionStart) => ageOn(dateOfBirth, sessionStart) < GUARDIAN_AGE;

/**
 * @param {{ now?: () => number }} [deps] clock, injectable for tests
 * @returns {(mapped: import('./map.js').MappedBooking) => string[]} reason codes; empty means valid
 */
export function createValidator({ now = Date.now } = {}) {
  return function validate({ bookingId, member, booking }) {
    const problems = [];
    const today = new Date(now()).toISOString().slice(0, 10);

    if (!isSafeId(bookingId)) problems.push('booking_id_invalid');

    for (const [field, value] of [['first_name', member.firstName], ['last_name', member.lastName]]) {
      if (value === '') problems.push(`${field}_missing`);
      else if (value.length > 100 || hasUnsafeText(value)) problems.push(`${field}_invalid`);
    }

    if (member.email === '') problems.push('email_missing');
    else if (!isEmail(member.email) || hasUnsafeText(member.email)) problems.push('email_invalid');

    const sessionOk = isIsoDateTime(booking.sessionStart);
    if (booking.sessionStart === '') problems.push('session_start_missing');
    else if (!sessionOk) problems.push('session_start_invalid');

    if (member.dateOfBirth === '') problems.push('date_of_birth_missing');
    else if (!isCalendarDate(member.dateOfBirth)) problems.push('date_of_birth_invalid');
    else if (member.dateOfBirth > today) problems.push('date_of_birth_in_future');
    else if (sessionOk && member.dateOfBirth > booking.sessionStart.slice(0, 10)) problems.push('date_of_birth_after_session');
    // A placeholder would make a child look like an adult and skip the guardian rule.
    else if (sessionOk && ageOn(member.dateOfBirth, booking.sessionStart) > MAX_AGE) problems.push('date_of_birth_implausible');

    if (!SESSION_TYPES.includes(booking.sessionType)) problems.push('session_type_invalid');
    if (!Number.isInteger(booking.amountPence) || booking.amountPence < 0 || booking.amountPence > 1_000_000) {
      problems.push('amount_invalid');
    }

    return problems;
  };
}
