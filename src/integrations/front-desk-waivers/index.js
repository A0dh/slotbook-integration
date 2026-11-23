// Front-desk waivers: climbers sign a waiver on a tablet at reception, and
// staff export the day's waivers as a CSV file. This integration imports that
// file into the CRM as members.
//
//   npm run import -- front-desk-waivers data/front-desk/waivers.csv

import { readFileSync } from 'node:fs';
import { parseCsv } from '../../lib/csv.js';
import { runPipeline } from '../../pipeline/run.js';
import { mapWaiver } from './map.js';
import { validateWaiver } from './validate.js';

/**
 * @param {{ crm: import('../../pipeline/crm-client.js').CrmClient, logger: import('../../lib/logger.js').Logger }} deps
 * @returns {import('../../pipeline/run.js').Integration}
 */
export function frontDeskWaivers({ crm, logger }) {
  return {
    source: 'front-desk-waivers',
    refOf: (row) => row.waiver_id || '(no waiver id)',
    map: mapWaiver,
    validate: validateWaiver,
    async send(member) {
      logger.info('Sending waiver to CRM', { member });
      await crm.upsertMember(member);
    },
  };
}

/**
 * Imports a waiver export file.
 * @param {string} filePath
 * @param {{ crm: import('../../pipeline/crm-client.js').CrmClient, logger: import('../../lib/logger.js').Logger }} deps
 */
export async function importWaiverFile(filePath, deps) {
  const rows = parseCsv(readFileSync(filePath, 'utf8'));
  return runPipeline(rows, frontDeskWaivers(deps), deps);
}
