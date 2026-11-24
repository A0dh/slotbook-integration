// Cleaning rules: a small, fixed catalogue of operations that a rule set switches on per field.
//
// A rule set is data (config/rules/<source>.json), written by a person approving suggestions
// (see suggest.js). Code defines what each operation does; the rule set only says which
// operation runs on which field. Validation of the cleaned record stays in code and cannot be
// relaxed by any rule set.
//
//   { "rules": [ { "field": "postcode", "op": "uk_postcode" },
//                { "field": "sessionStart", "op": "uk_date", "format": "DD/MM/YYYY HH:mm" } ] }

import { readFileSync } from 'node:fs';
import { isCalendarDate, isUkPostcode } from '../lib/validators.js';

/** Date formats `uk_date` understands: day first, as used in the UK. */
export const UK_DATE_FORMATS = /** @type {const} */ (['DD/MM/YYYY', 'DD/MM/YYYY HH:mm']);

/**
 * Each operation takes a string and returns the cleaned string, or the value unchanged when it
 * doesn't apply or can't clean it (validation then decides). Listed in the order they run.
 * @type {Record<string, { describe: string, apply: (value: string, rule: Rule) => string }>}
 */
export const OPERATIONS = {
  lowercase: {
    describe: 'Convert to lower case',
    apply: (value) => value.toLowerCase(),
  },
  title_case: {
    describe: 'Capitalise names typed entirely in upper or lower case; mixed case is left alone',
    apply: titleCase,
  },
  uk_postcode: {
    describe: 'Upper-case a UK postcode and put one space before the last three characters',
    apply: ukPostcode,
  },
  uk_phone: {
    describe: 'Write a UK phone number in international form, e.g. +447700900123',
    apply: ukPhone,
  },
  uk_date: {
    describe: 'Convert a day-first UK date (and UK local time) to ISO 8601; ISO values are left alone',
    apply: ukDate,
  },
};

const ORDER = Object.keys(OPERATIONS);
const MAX_RULES = 50;

/**
 * @typedef {{ field: string, op: string, format?: string, reason?: string }} Rule
 * @typedef {{ rules: Rule[] }} RuleSet
 */

/**
 * Checks a rule set against the operations above and the fields a source has. Used for the
 * approved file (any error is fatal) and for AI suggestions (bad items are dropped).
 * @param {unknown} ruleSet
 * @param {readonly string[]} fields field names the rules may target
 * @returns {{ rules: Rule[], errors: string[] }}
 */
export function validateRuleSet(ruleSet, fields) {
  const items = /** @type {{ rules?: unknown }} */ (ruleSet)?.rules;
  if (!Array.isArray(items)) return { rules: [], errors: ['Rule set has no "rules" list'] };
  if (items.length > MAX_RULES) return { rules: [], errors: [`Rule set has more than ${MAX_RULES} rules`] };

  /** @type {Rule[]} */
  const rules = [];
  const errors = [];
  const seen = new Set();
  items.forEach((item, i) => {
    const { field, op, format, reason } = item ?? {};
    const problem =
      !fields.includes(field) ? `unknown field ${JSON.stringify(field)}`
      : !Object.hasOwn(OPERATIONS, op) ? `unknown operation ${JSON.stringify(op)}`
      : op === 'uk_date' && !UK_DATE_FORMATS.includes(format) ? `uk_date needs a format: ${UK_DATE_FORMATS.join(' or ')}`
      : seen.has(`${field}:${op}`) ? `duplicate rule ${op} on ${field}`
      : null;
    if (problem) {
      errors.push(`Rule ${i + 1}: ${problem}`);
      return;
    }
    seen.add(`${field}:${op}`);
    rules.push({ field, op, ...(op === 'uk_date' && { format }), ...(typeof reason === 'string' && { reason: reason.slice(0, 500) }) });
  });
  return { rules, errors };
}

/**
 * Loads an approved rule set. A missing file means no cleaning yet (records still go through
 * validation, so more are rejected); an invalid one is an error, never silently ignored.
 * @param {string} path
 * @param {readonly string[]} fields
 * @returns {{ rules: Rule[], missing: boolean }}
 */
export function loadRuleSet(path, fields) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { rules: [], missing: true };
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Rule set ${path} is not valid JSON`);
  }
  const { rules, errors } = validateRuleSet(parsed, fields);
  if (errors.length > 0) throw new Error(`Rule set ${path} is invalid: ${errors.join('; ')}`);
  return { rules, missing: false };
}

/**
 * Applies rules to a record's string fields, in the fixed operation order (so the order of the
 * rule set doesn't matter). Calls `onChange` with `op(field)` each time a value changes.
 * @template {Record<string, unknown>} T
 * @param {T} record
 * @param {Rule[]} rules
 * @param {(rule: string) => void} [onChange]
 * @returns {T}
 */
export function applyRules(record, rules, onChange = () => {}) {
  const result = { ...record };
  const ordered = [...rules].sort((a, b) => ORDER.indexOf(a.op) - ORDER.indexOf(b.op));
  for (const rule of ordered) {
    const value = result[rule.field];
    if (typeof value !== 'string' || value === '') continue;
    const cleaned = OPERATIONS[rule.op].apply(value, rule);
    if (cleaned !== value) {
      /** @type {Record<string, unknown>} */ (result)[rule.field] = cleaned;
      onChange(`${rule.op}(${rule.field})`);
    }
  }
  return result;
}

// ---- operations --------------------------------------------------------------------------

/** @param {string} value */
function titleCase(value) {
  const singleCase = value === value.toUpperCase() || value === value.toLowerCase();
  if (!singleCase) return value; // McKenzie, DuBois, de Souza: already deliberate
  // Capitalise the first letter of each part, keeping the separators: O'NEILL → O'Neill.
  return value.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_, sep, letter) => sep + letter.toUpperCase());
}

/** @param {string} value */
function ukPostcode(value) {
  const compact = value.replace(/\s+/g, '').toUpperCase();
  const spaced = `${compact.slice(0, -3)} ${compact.slice(-3)}`;
  return isUkPostcode(spaced) ? spaced : value;
}

/** @param {string} value */
function ukPhone(value) {
  if (!/^\+?[\d\s()-]+$/.test(value)) return value;
  const digits = value.replace(/\D/g, '').replace(/^440/, '44'); // +44 (0)7700… → +447700…
  if (/^0\d{10}$/.test(digits)) return `+44${digits.slice(1)}`;
  if (/^44\d{10}$/.test(digits)) return `+${digits}`;
  return value;
}

/**
 * @param {string} value
 * @param {Rule} rule
 */
function ukDate(value, rule) {
  const withTime = rule.format === 'DD/MM/YYYY HH:mm';
  const match = (withTime ? /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/ : /^(\d{2})\/(\d{2})\/(\d{4})$/).exec(value);
  if (!match) return value;
  const [, d, m, y, hh = '00', mm = '00'] = match;
  const date = `${y}-${m}-${d}`;
  if (!isCalendarDate(date) || Number(hh) > 23 || Number(mm) > 59) return value;
  return withTime ? londonToUtc(date, Number(hh), Number(mm)) : date;
}

const londonClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** Milliseconds UK local time is ahead of UTC at a given instant (0 in winter, 1 h in summer). */
function londonOffsetMs(utcMs) {
  const parts = Object.fromEntries(londonClock.formatToParts(utcMs).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) - utcMs;
}

/**
 * UK local wall-clock time → ISO 8601 UTC. A time in the spring-forward gap (which never
 * happened) moves an hour on; one in the autumn overlap (which happened twice) is read as the
 * second, GMT, occurrence.
 * @param {string} date `YYYY-MM-DD`
 * @param {number} hour
 * @param {number} minute
 */
function londonToUtc(date, hour, minute) {
  const [y, m, d] = date.split('-').map(Number);
  const asIfUtc = Date.UTC(y, m - 1, d, hour, minute);
  const guess = asIfUtc - londonOffsetMs(asIfUtc);
  const utc = asIfUtc - londonOffsetMs(guess);
  return new Date(utc).toISOString().replace('.000Z', 'Z');
}
