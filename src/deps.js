// Builds the shared dependencies once, from configuration.

import { config } from './config.js';
import { logger } from './lib/logger.js';
import { createCrmClient } from './pipeline/crm-client.js';

export function createDeps() {
  const crm = createCrmClient({ baseUrl: config.crmUrl, apiKey: config.crmApiKey });
  return { crm, logger };
}

/** @typedef {ReturnType<typeof createDeps>} Deps */
