// Sends the sample webhooks in data/<source>/webhooks/ to the integration
// service, in filename order, the way the real platform would.
//
//   npm run send-webhooks -- chalk-shop
//   npm run send-webhooks -- slotbook
//   npm run send-webhooks -- slotbook --url http://localhost:3000/some/other/path
//
// SlotBook webhooks are signed with SLOTBOOK_WEBHOOK_SECRET (see docs/slotbook.md).
// Set the same value for your integration.

import { createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = process.env.PORT ?? 3000;

const sources = {
  'chalk-shop': {
    dir: 'data/chalk-shop/webhooks',
    url: `http://localhost:${PORT}/webhooks/chalk-shop`,
    headers: () => ({ 'x-chalk-token': requireEnv('CHALK_SHOP_WEBHOOK_TOKEN') }),
  },
  slotbook: {
    dir: 'data/slotbook/webhooks',
    url: `http://localhost:${PORT}/webhooks/slotbook`,
    headers: (body) => ({ 'slotbook-signature': signSlotBook(body, requireEnv('SLOTBOOK_WEBHOOK_SECRET')) }),
  },
};

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Set ${name} in .env first.`);
    process.exit(1);
  }
  return value;
}

/** SlotBook's signature scheme: HMAC-SHA256 of "<timestamp>.<raw body>". */
function signSlotBook(body, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

const [name, ...rest] = process.argv.slice(2);
const source = sources[name];
if (!source) {
  console.error(`Usage: npm run send-webhooks -- <${Object.keys(sources).join(' | ')}> [--url <url>]`);
  process.exit(1);
}
const urlFlag = rest.indexOf('--url');
const url = urlFlag === -1 ? source.url : rest[urlFlag + 1];

const files = readdirSync(source.dir).filter((f) => f.endsWith('.json')).sort();
for (const file of files) {
  const body = readFileSync(join(source.dir, file), 'utf8');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...source.headers(body) },
      body,
    });
    console.log(`${file} → ${res.status} ${await res.text()}`);
  } catch (err) {
    console.log(`${file} → could not connect to ${url} (${err.cause?.code ?? err.message})`);
  }
}
