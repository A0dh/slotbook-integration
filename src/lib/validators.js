// Field checks shared by the cleaning rules and the integrations. Pure functions, no I/O.
// Where the CRM has a rule (docs/crm-schema.md), these are at least as strict, so a record
// that passes here is not refused by the CRM for format reasons.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UK_POSTCODE = /^[A-Z]{1,2}[0-9][A-Z0-9]? [0-9][A-Z]{2}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
// Markup, control characters, or a leading spreadsheet-formula character.
const UNSAFE_TEXT = /[<>\u0000-\u001F\u007F]|^[=+\-@]/;
// What people type into a form when they have nothing to say.
const PLACEHOLDERS = new Set(['n/a', 'na', 'none', 'unknown', 'null', 'tbc', '-', '.']);

/** @param {unknown} value */
export const isEmail = (value) => typeof value === 'string' && value.length <= 254 && EMAIL.test(value);

/** @param {unknown} value e.g. `SW1A 1AA` (capitals, one space) */
export const isUkPostcode = (value) => typeof value === 'string' && UK_POSTCODE.test(value);

/**
 * A real calendar date in `YYYY-MM-DD` form (rejects 2025-02-29, which Date.parse rolls over).
 * @param {unknown} value
 */
export function isCalendarDate(value) {
  const match = typeof value === 'string' && ISO_DATE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * An ISO 8601 date-time with a time zone, on a real calendar date.
 * @param {unknown} value
 */
export const isIsoDateTime = (value) =>
  typeof value === 'string' && ISO_DATETIME.test(value) && isCalendarDate(value.slice(0, 10)) && !Number.isNaN(Date.parse(value));

/**
 * Whole years of age on a given day. Both dates must already be valid. Someone born on
 * 29 February turns a year older on 1 March in non-leap years.
 * @param {string} dateOfBirth `YYYY-MM-DD`
 * @param {string} isoDate a date or date-time; only its date part (UTC) counts
 */
export function ageOn(dateOfBirth, isoDate) {
  const on = new Date(isoDate);
  const [y, m, d] = dateOfBirth.split('-').map(Number);
  const age = on.getUTCFullYear() - y;
  const hadBirthday = on.getUTCMonth() + 1 > m || (on.getUTCMonth() + 1 === m && on.getUTCDate() >= d);
  return hadBirthday ? age : age - 1;
}

/**
 * Text that is unsafe to store in a name-like field: markup, control characters, or a
 * leading `= + - @` that spreadsheets run as a formula when staff export the data.
 * @param {string} value
 */
export const hasUnsafeText = (value) => UNSAFE_TEXT.test(value);

/**
 * A phone number with 10–15 digits, written with digits, spaces, `+`, `-` or brackets only.
 * @param {unknown} value
 */
export function isPhone(value) {
  if (typeof value !== 'string' || !/^\+?[\d\s()-]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, '').length;
  return digits >= 10 && digits <= 15;
}

/**
 * A guardian contact staff could actually use: a safe, non-empty name and a phone number.
 * @param {unknown} guardian
 */
export function isValidGuardian(guardian) {
  if (typeof guardian !== 'object' || guardian === null) return false;
  const { name, phone } = /** @type {{ name?: unknown, phone?: unknown }} */ (guardian);
  return (
    typeof name === 'string' &&
    name.trim().length >= 1 &&
    name.length <= 100 &&
    !PLACEHOLDERS.has(name.trim().toLowerCase()) &&
    !hasUnsafeText(name) &&
    isPhone(phone)
  );
}
