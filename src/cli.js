// Command-line imports.
//
//   npm run import -- <integration> <file>
//   npm run import -- front-desk-waivers data/front-desk/waivers.csv

import { createDeps } from './deps.js';
import { importWaiverFile } from './integrations/front-desk-waivers/index.js';
import { importSlotbookFile } from './integrations/slotbook/index.js';

/** File importers, by integration name. Add new ones here. */
const importers = {
  'front-desk-waivers': importWaiverFile,
  slotbook: importSlotbookFile,
};

const [command, name, filePath] = process.argv.slice(2);

if (command !== 'import' || !importers[name] || !filePath) {
  console.error(`Usage: npm run import -- <integration> <file>\nIntegrations: ${Object.keys(importers).join(', ')}`);
  process.exit(1);
}

const summary = await importers[name](filePath, createDeps());
console.log(`\n${summary.toText()}`);
