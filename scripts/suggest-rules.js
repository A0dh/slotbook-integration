// Suggests cleaning rules for an integration from a sample export, asks you to approve each
// one, and writes the approved set where imports and webhooks read it.
//
//   npm run rules:suggest -- slotbook data/slotbook/backfill.csv
//
// Needs ANTHROPIC_API_KEY. Only a profile of value shapes is sent to Claude; the only real values
// sent are session types from SlotBook's fixed list.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { config } from '../src/config.js';
import { parseCsv } from '../src/lib/csv.js';
import { RULES_PATH } from '../src/integrations/slotbook/index.js';
import { FIELDS, fromCsvRow } from '../src/integrations/slotbook/map.js';
import { SESSION_TYPES } from '../src/integrations/slotbook/validate.js';
import { preview, printable, profile, suggest } from '../src/rules/suggest.js';

/** Integrations with rule sets: their fields, how to read an export, where approved rules go. */
const sources = {
  slotbook: {
    // Notes are free text: no operation applies to them, and they are the likeliest to hold personal data.
    fields: FIELDS.filter((field) => field !== 'notes'),
    knownValues: { sessionType: SESSION_TYPES },
    read: (file) => parseCsv(readFileSync(file, 'utf8')).map(fromCsvRow),
    rulesPath: RULES_PATH,
  },
};

const [name, file] = process.argv.slice(2);
const source = sources[name];
if (!source || !file) {
  console.error(`Usage: npm run rules:suggest -- <integration> <export file>\nIntegrations: ${Object.keys(sources).join(', ')}`);
  process.exit(1);
}

const records = source.read(file);
console.log(`Profiled ${records.length} records from ${basename(file)}. Asking ${config.anthropicModel} for suggestions…`);

let suggestion;
try {
  suggestion = await suggest({
    fieldProfile: profile(records, source.fields, { knownValues: source.knownValues }),
    fields: source.fields,
    apiKey: config.anthropicApiKey,
    model: config.anthropicModel,
  });
} catch (err) {
  console.error(`No suggestions: ${err.message}. Nothing was changed; ${source.rulesPath} stays as it is.`);
  process.exit(1);
}

for (const error of suggestion.errors) console.log(`Dropped an invalid suggestion: ${printable(error)}`);

const approved = [];
// Answers are read as lines from an iterator, which buffers them: rl.question() loses lines
// that arrive before it is asked (piped or pasted input). No more input counts as "no".
const rl = createInterface({ input: process.stdin });
const answers = rl[Symbol.asyncIterator]();
const approves = async () => {
  process.stdout.write('  Approve? [y/N] ');
  const { value = '' } = await answers.next();
  return value.trim().toLowerCase() === 'y';
};
for (const [i, rule] of suggestion.rules.entries()) {
  const { changed, samples } = preview(rule, records);
  console.log(`\n${i + 1}/${suggestion.rules.length}  ${rule.op}(${rule.field})${rule.format ? `  format ${rule.format}` : ''}`);
  console.log(`  Why: ${printable(rule.reason ?? '(no reason given)')}`);
  console.log(`  Changes ${changed} of ${records.length} records`);
  for (const { before, after } of samples) console.log(`    ${printable(before)}  →  ${printable(after)}`);
  if (await approves()) approved.push(rule);
}
rl.close();

if (approved.length === 0) {
  console.log(`\nNo rules approved. Nothing was changed; ${source.rulesPath} stays as it is.`);
  process.exit(0);
}

mkdirSync(dirname(source.rulesPath), { recursive: true });
const ruleSet = { approvedAt: new Date().toISOString(), suggestedBy: config.anthropicModel, sample: basename(file), rules: approved };
writeFileSync(source.rulesPath, `${JSON.stringify(ruleSet, null, 2)}\n`);
console.log(`\nWrote ${approved.length} approved rule(s) to ${source.rulesPath}. Imports and webhooks use them from now on.`);
