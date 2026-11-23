// Configuration comes from environment variables. The npm scripts load .env
// automatically (node --env-file-if-exists=.env).
//
// Secrets are read lazily, so importing this module never fails; code that
// needs a secret fails with a clear message when it first asks for it.

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  crmUrl: process.env.CRM_URL ?? 'http://localhost:4010',
  get crmApiKey() {
    return required('CRM_API_KEY');
  },
  get chalkShopWebhookToken() {
    return required('CHALK_SHOP_WEBHOOK_TOKEN');
  },
  get slotbookWebhookSecret() {
    return required('SLOTBOOK_WEBHOOK_SECRET');
  },
  // Only the AI rule suggestions need these; the integration runs without them.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
};
