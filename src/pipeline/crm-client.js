// Client for Bramble Wall's membership system (the "CRM").
// API reference: docs/crm-schema.md

import { setTimeout as delay } from 'node:timers/promises';

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

const sleep = (ms, signal) => delay(ms, undefined, { signal });

/**
 * Retry policy for the batch and lookup methods. Retrying them is safe: members are matched
 * by email, GETs don't write, and bookings are safe as long as each carries an idempotencyKey.
 */
export const RETRY_POLICY = Object.freeze({
  /** Attempts for 5xx and network errors, including the first. */
  attempts: 5,
  /** Separate cap for 429s, which only mean "slow down". */
  rateLimitAttempts: 10,
  baseDelayMs: 250,
  maxDelayMs: 4000,
  maxRetryAfterMs: 30_000,
  /** Per attempt, so one slow response can't hang an import. */
  timeoutMs: 10_000,
});

/**
 * @param {{
 *   baseUrl: string,
 *   apiKey: string,
 *   fetchImpl?: typeof fetch,
 *   wait?: (ms: number, signal?: AbortSignal) => Promise<unknown>,
 *   retryPolicy?: typeof RETRY_POLICY,
 * }} options
 */
export function createCrmClient({ baseUrl, apiKey, fetchImpl = fetch, wait = sleep, retryPolicy = RETRY_POLICY }) {
  const headers = { 'content-type': 'application/json', 'x-api-key': apiKey };

  async function request(method, path, body, attempt = 1) {
    const res = await fetchImpl(new URL(path, baseUrl), {
      method,
      headers,
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

  /**
   * One attempt with its own timeout. Never throws on a bad body: a 5xx from a proxy is often HTML.
   * @returns {Promise<{ status: number, headers: Headers, data: any }>}
   */
  async function attempt(method, path, body, signal) {
    const timeout = AbortSignal.timeout(retryPolicy.timeoutMs);
    const res = await fetchImpl(new URL(path, baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Leave data null; the status code decides what happens next.
    }
    return { status: res.status, headers: res.headers, data };
  }

  /**
   * Retries 429 (honouring Retry-After), 5xx, timeouts and network errors. Other 4xx are final.
   * Gives up with a CrmError. An aborted `signal` stops everything immediately, including a
   * pending wait, and rejects with the signal's reason (an AbortError), not a CrmError.
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @param {{ signal?: AbortSignal }} [options]
   */
  async function requestWithRetry(method, path, body, { signal } = {}) {
    let failures = 0;
    let rateLimits = 0;
    for (;;) {
      signal?.throwIfAborted();
      let result;
      let networkError;
      try {
        result = await attempt(method, path, body, signal);
      } catch (err) {
        signal?.throwIfAborted();
        networkError = err;
      }

      if (result && result.status >= 200 && result.status < 300) return result.data;

      if (result?.status === 429 && ++rateLimits < retryPolicy.rateLimitAttempts) {
        await wait(retryAfterMs(result.headers.get('retry-after')), signal);
        continue;
      }

      const retryable = networkError !== undefined || (result !== undefined && result.status >= 500);
      if (!retryable || ++failures >= retryPolicy.attempts) {
        if (networkError) throw new CrmError(0, `CRM unreachable: ${networkError.message}`);
        const status = /** @type {{ status: number, data: any }} */ (result).status;
        const data = /** @type {{ status: number, data: any }} */ (result).data;
        throw new CrmError(status, data?.error?.message ?? `CRM responded ${status}`, data);
      }
      await wait(backoffMs(failures), signal);
    }
  }

  /** @param {string | null} header seconds or an HTTP date */
  function retryAfterMs(header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) && header !== null && header.trim() !== ''
      ? seconds * 1000
      : Date.parse(header ?? '') - Date.now();
    if (!Number.isFinite(ms) || ms < 0) return 1000;
    return Math.min(ms, retryPolicy.maxRetryAfterMs);
  }

  /** Exponential backoff with jitter, so parallel clients don't retry in lockstep. */
  function backoffMs(failures) {
    const ceiling = Math.min(retryPolicy.maxDelayMs, retryPolicy.baseDelayMs * 2 ** (failures - 1));
    return Math.round(ceiling * (0.5 + Math.random() / 2));
  }

  /**
   * @param {string} path
   * @param {string} key
   * @param {unknown[]} items
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<BatchResult[]>}
   */
  async function batch(path, key, items, options) {
    const data = await requestWithRetry('POST', path, { [key]: items }, options);
    if (!Array.isArray(data?.results)) throw new CrmError(502, 'CRM batch response had no results', data);
    return data.results;
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

    /**
     * Creates or matches up to 100 members. Each result succeeds or fails on its own.
     * @param {object[]} members
     * @param {{ signal?: AbortSignal }} [options]
     */
    upsertMembers: (members, options) => batch('/members/batch', 'members', members, options),

    /**
     * Creates up to 100 bookings. Give each an `idempotencyKey` so retries are safe.
     * @param {object[]} bookings
     * @param {{ signal?: AbortSignal }} [options]
     */
    createBookings: (bookings, options) => batch('/bookings/batch', 'bookings', bookings, options),

    /**
     * The member with exactly this email (the CRM's match is case-sensitive), or null.
     * @param {string} email
     * @param {{ signal?: AbortSignal }} [options]
     * @returns {Promise<Record<string, any> | null>}
     */
    async findMemberByEmail(email, options) {
      const data = await requestWithRetry('GET', `/members?email=${encodeURIComponent(email)}`, undefined, options);
      return data?.members?.[0] ?? null;
    },
  };
}

/**
 * One item of a batch response.
 * @typedef {{ index: number, status: number, id?: string, created?: boolean, error?: { code: string, message: string, fields?: Record<string, string> } }} BatchResult
 */

/** @typedef {ReturnType<typeof createCrmClient>} CrmClient */
