// Chalk Shop: the gym's online shop sends a webhook for each order.
// Each order becomes a CRM member (created or matched by email) and a booking.
//
//   POST /webhooks/chalk-shop
//   Header x-chalk-token must match CHALK_SHOP_WEBHOOK_TOKEN.

import { config } from '../../config.js';
import { HttpError, parseJsonBody, readBody, sendJson } from '../../lib/http.js';
import { runPipeline } from '../../pipeline/run.js';
import { mapOrder } from './map.js';
import { validateOrder } from './validate.js';

/**
 * @param {{ crm: import('../../pipeline/crm-client.js').CrmClient, logger: import('../../lib/logger.js').Logger }} deps
 * @returns {import('../../pipeline/run.js').Integration}
 */
export function chalkShop({ crm }) {
  return {
    source: 'chalk-shop',
    refOf: (order) => order?.orderId ?? '(no order id)',
    map: mapOrder,
    validate: validateOrder,
    async send({ member, booking }) {
      const { id: memberId } = await crm.upsertMember(member);
      await crm.createBooking({ ...booking, memberId });
    },
  };
}

/**
 * HTTP handler for Chalk Shop webhooks.
 * @param {{ crm: import('../../pipeline/crm-client.js').CrmClient, logger: import('../../lib/logger.js').Logger }} deps
 */
export function chalkShopWebhookHandler(deps) {
  const integration = chalkShop(deps);

  return async (req, res) => {
    if (req.headers['x-chalk-token'] !== config.chalkShopWebhookToken) {
      throw new HttpError(401, 'Invalid token');
    }

    const order = parseJsonBody(await readBody(req));
    const summary = await runPipeline([order], integration, deps);

    if (summary.rejected.length > 0) {
      return sendJson(res, 422, { status: 'rejected', reasons: summary.rejected[0].reasons });
    }
    if (summary.failed.length > 0) {
      // A 5xx tells Chalk Shop to retry later.
      return sendJson(res, 502, { status: 'failed' });
    }
    return sendJson(res, 200, { status: 'imported' });
  };
}
