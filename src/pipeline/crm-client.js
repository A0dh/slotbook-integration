// Client for Bramble Wall's membership system (the "CRM").
// API reference: docs/crm-schema.md

export class CrmError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {unknown} [body]
   */
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ baseUrl: string, apiKey: string, fetchImpl?: typeof fetch, wait?: (ms: number) => Promise<void> }} options
 */
export function createCrmClient({ baseUrl, apiKey, fetchImpl = fetch, wait = sleep }) {
  async function request(method, path, body, attempt = 1) {
    const res = await fetchImpl(new URL(path, baseUrl), {
      method,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // The CRM rate-limits us now and then; wait a second and try again.
    if (res.status === 429 && attempt < 3) {
      await wait(1000);
      return request(method, path, body, attempt + 1);
    }

    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      throw new CrmError(res.status, data?.error?.message ?? `CRM responded ${res.status}`, data);
    }
    return data;
  }

  return {
    /**
     * Creates a member, or returns the existing one with the same email.
     * @param {object} member
     * @returns {Promise<{ id: string, created: boolean }>}
     */
    upsertMember: (member) => request('POST', '/members', member),

    /**
     * @param {object} booking
     * @returns {Promise<{ id: string }>}
     */
    createBooking: (booking) => request('POST', '/bookings', booking),
  };
}

/** @typedef {ReturnType<typeof createCrmClient>} CrmClient */
