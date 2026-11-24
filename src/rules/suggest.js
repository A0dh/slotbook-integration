// AI-suggested cleaning rules, approved by a person before any data is affected.
//
//   1. profile()   what the values of each field look like, without the values themselves
//   2. suggest()   one request to Claude, which may only answer with operations from the
//                  catalogue in index.js; the answer is checked again with validateRuleSet()
//   3. preview()   what each suggested rule would change in the real data, for review
//
// Imports and webhooks never call the AI: they only read the approved rule set. If the AI is
// slow, wrong or unavailable, nothing is written and the current rules stay as they are.

import { OPERATIONS, UK_DATE_FORMATS, applyRules, validateRuleSet } from './index.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
const TIMEOUT_MS = 60_000;
/** Shapes seen fewer times than this are left out: rare shapes are where personal data leaks. */
const MIN_SHAPE_COUNT = 5;
const MAX_SHAPES = 10;

/**
 * A value's shape: runs of capitals → A, runs of small letters → a, runs of letters without
 * case (Chinese, Arabic…) → x, each digit → 9.
 * "O'NEILL" → "A'A", "07700 900123" → "99999 999999", "sw1a 1aa" → "a9a 9a", "李伟" → "x".
 * @param {string} value
 */
export const shapeOf = (value) =>
  value
    .replace(/\p{M}+/gu, '') // accents and vowel signs first, so they don't split or survive in a run of letters
    .replace(/\p{Lu}+/gu, 'A')
    .replace(/\p{Ll}+/gu, 'a')
    .replace(/[\p{Lo}\p{Lm}\p{Lt}]+/gu, 'x')
    .replace(/\p{N}/gu, '9')
    .slice(0, 40);

/**
 * Per field: how many values are empty and the most common shapes. A value itself is only
 * included when it is in that field's `knownValues` (a fixed vocabulary, such as session types);
 * anything else, however often it repeats, is sent as a shape.
 * @param {Record<string, string>[]} records
 * @param {readonly string[]} fields
 * @param {{ knownValues?: Record<string, readonly string[]> }} [options]
 */
export function profile(records, fields, { knownValues = {} } = {}) {
  return Object.fromEntries(
    fields.map((field) => {
      const counts = new Map();
      let empty = 0;
      for (const record of records) {
        const value = record[field] ?? '';
        if (value === '') empty++;
        else {
          const key = knownValues[field]?.includes(value) ? `value:${value}` : `shape:${shapeOf(value)}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      const common = [...counts]
        .filter(([, count]) => count >= MIN_SHAPE_COUNT)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_SHAPES)
        .map(([key, count]) => {
          const [kind, text] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
          return { [kind]: text, count };
        });
      return [field, { records: records.length, empty, common }];
    }),
  );
}

/** @param {readonly string[]} fields */
function outputSchema(fields) {
  return {
    type: 'object',
    properties: {
      rules: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            field: { type: 'string', enum: [...fields] },
            op: { type: 'string', enum: Object.keys(OPERATIONS) },
            format: { anyOf: [{ type: 'string', enum: [...UK_DATE_FORMATS] }, { type: 'null' }] },
            reason: { type: 'string' },
          },
          required: ['field', 'op', 'format', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['rules'],
    additionalProperties: false,
  };
}

/** @param {object} fieldProfile */
function prompt(fieldProfile) {
  const catalogue = Object.entries(OPERATIONS).map(([op, { describe }]) => `- ${op}: ${describe}`).join('\n');
  return `You are helping a UK climbing gym chain clean booking data before it is imported into their CRM.

Below is a profile of each field in an export: how many values are empty and the most common value shapes. In a shape, a run of capital letters is "A", a run of small letters is "a", a run of letters without case is "x" and each digit is "9", so "O'NEILL" is "A'A" and "SW1A 1AA" is "A9A 9A". No real values are included except where a field shows "value".

Suggest the cleaning rules worth applying, using only these operations:
${catalogue}

uk_date needs a format: ${UK_DATE_FORMATS.join(' or ')} (format is null for every other operation). The target formats are ISO 8601 dates (YYYY-MM-DD) and date-times in UTC.

Suggest a rule only where the profile shows values it would fix. Give each a one-sentence reason a member of staff can check against the profile. Validation runs after cleaning and rejects what is still wrong, so do not suggest rules to hide bad data.

<profile>
${JSON.stringify(fieldProfile, null, 2)}
</profile>`;
}

/**
 * Asks Claude for rule suggestions. Throws with a message fit for the person running it when the
 * API is unreachable, slow, refuses or answers in an unexpected way.
 * @param {{
 *   fieldProfile: object,
 *   fields: readonly string[],
 *   apiKey: string,
 *   model: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<{ rules: import('./index.js').Rule[], errors: string[] }>} usable rules, and why others were dropped
 */
export async function suggest({ fieldProfile, fields, apiKey, model, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');

  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION },
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: outputSchema(fields) } },
        messages: [{ role: 'user', content: prompt(fieldProfile) }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? `Claude did not answer within ${timeoutMs / 1000} s` : `Could not reach Claude: ${err.message}`);
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Claude API responded ${res.status}${body?.error?.type ? ` (${body.error.type})` : ''}`);
  if (body?.stop_reason === 'refusal') throw new Error('Claude declined to suggest rules');
  if (body?.stop_reason !== 'end_turn') throw new Error(`Claude's answer was incomplete (stop reason: ${body?.stop_reason})`);

  const text = body.content?.find((block) => block.type === 'text')?.text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Claude did not answer with JSON');
  }
  // The schema already constrains the answer; this is the check that doesn't depend on it.
  return validateRuleSet(parsed, fields);
}

/**
 * What a rule would do to the data: how many records it changes and a few before → after examples.
 * @param {import('./index.js').Rule} rule
 * @param {Record<string, string>[]} records
 * @param {number} [examples]
 */
export function preview(rule, records, examples = 2) {
  let changed = 0;
  const samples = [];
  for (const record of records) {
    const after = applyRules(record, [rule])[rule.field];
    if (after === record[rule.field]) continue;
    changed++;
    if (samples.length < examples) samples.push({ before: record[rule.field], after });
  }
  return { changed, samples };
}

/**
 * For printing untrusted text (AI reasons, data values) to a terminal: no control characters,
 * so nothing can move the cursor or rewrite what the reviewer sees.
 * @param {unknown} value
 */
export const printable = (value) => String(value).replace(/[\u0000-\u001F\u007F-\u009F]/g, '?').slice(0, 300);
