// The integration service's HTTP routes. Add new routes to the table below.

import { config } from './config.js';
import { chalkShopWebhookHandler } from './integrations/chalk-shop/index.js';
import { slotbookWebhookHandler } from './integrations/slotbook/index.js';
import { HttpError, sendHtml, sendJson } from './lib/http.js';

/**
 * @param {import('./deps.js').Deps} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApp(deps) {
  const { logger } = deps;

  /** @type {{ method: string, path: string, handler: (req: any, res: any) => Promise<void> | void }[]} */
  const routes = [
    { method: 'GET', path: '/', handler: (req, res) => sendHtml(res, 200, homePage()) },
    { method: 'GET', path: '/health', handler: (req, res) => sendJson(res, 200, { status: 'ok' }) },
    { method: 'POST', path: '/webhooks/chalk-shop', handler: chalkShopWebhookHandler(deps) },
    {
      method: 'POST',
      path: '/webhooks/slotbook',
      handler: slotbookWebhookHandler({ ...deps, webhookSecret: () => config.slotbookWebhookSecret }),
    },
  ];

  return async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const route = routes.find((r) => r.method === req.method && r.path === pathname);

    try {
      if (!route) throw new HttpError(404, 'Not found');
      await route.handler(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        logger.error('Unhandled error', { path: pathname, error: err.message, stack: err.stack });
        sendJson(res, 500, { error: 'Something went wrong' });
      }
    }
  };
}

function homePage() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Bramble Wall integrations</title></head>
<body>
  <h1>Bramble Wall integrations</h1>
  <ul>
    <li>Front-desk waivers: CSV import (<code>npm run import -- front-desk-waivers &lt;file&gt;</code>)</li>
    <li>Chalk Shop: webhook at <code>POST /webhooks/chalk-shop</code></li>
    <li>SlotBook: webhook at <code>POST /webhooks/slotbook</code>; export import (<code>npm run import -- slotbook &lt;file&gt;</code>)</li>
  </ul>
</body>
</html>`;
}
