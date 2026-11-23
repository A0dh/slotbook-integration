// Mock of Bramble Wall's membership system (the "CRM"). API: docs/crm-schema.md
//
// It behaves like a real third-party API, so by default it misbehaves now and
// then: rate limits, occasional server errors and slow responses.
// Set MOCK_CRM_CHAOS=off to switch that off while debugging.
//
//   npm run crm

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const RATE_LIMIT_PER_SECOND = 20;
const SERVER_ERROR_RATE = 0.02;
const SLOW_RESPONSE_RATE = 0.01;
const SLOW_RESPONSE_MS = 5000;
const MAX_BATCH = 100;
const MAX_BODY_BYTES = 1_000_000;

const SESSION_TYPES = ['bouldering', 'top-rope', 'lead', 'course', 'other'];
const POSTCODE = /^[A-Z]{1,2}[0-9][A-Z0-9]? [0-9][A-Z]{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const MEMBER_FIELDS = ['firstName', 'lastName', 'email', 'dateOfBirth', 'postcode', 'phone', 'guardian', 'source', 'sourceRef'];
const BOOKING_FIELDS = ['memberId', 'sessionStart', 'sessionType', 'amountPence', 'notes', 'source', 'sourceRef'];

class ApiError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

/**
 * @param {{ apiKey: string, chaos?: boolean, random?: () => number, now?: () => number }} options
 */
export function createMockCrm({ apiKey, chaos = true, random = Math.random, now = Date.now }) {
  /** @type {Map<string, any>} */
  const members = new Map();
  /** @type {Map<string, string>} email → member id */
  const membersByEmail = new Map();
  /** @type {Map<string, any>} */
  const bookings = new Map();
  /** @type {Map<string, { fingerprint: string, status: number, body: any }>} */
  const idempotency = new Map();
  /** @type {number[]} */
  let recentRequests = [];
  const stats = emptyStats();

  function emptyStats() {
    return { requests: 0, rateLimited: 0, serverErrors: 0, slowResponses: 0, validationErrors: 0, idempotentReplays: 0 };
  }

  // ---- validation --------------------------------------------------------

  function checkUnknownFields(body, allowed, extra = []) {
    const unknown = Object.keys(body).filter((key) => !allowed.includes(key) && !extra.includes(key));
    return unknown.length ? { _unknown: `Unknown field(s): ${unknown.join(', ')}` } : {};
  }

  function isCalendarDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }

  function text(value, max) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  }

  function validateMember(body, extra) {
    const fields = checkUnknownFields(body, MEMBER_FIELDS, extra);
    if (!text(body.firstName, 100)) fields.firstName = 'Required, 1-100 characters';
    if (!text(body.lastName, 100)) fields.lastName = 'Required, 1-100 characters';
    if (typeof body.email !== 'string' || !EMAIL.test(body.email) || body.email.length > 254) fields.email = 'Required, must be a valid email address';
    if (!isCalendarDate(body.dateOfBirth)) fields.dateOfBirth = 'Required, YYYY-MM-DD';
    else if (body.dateOfBirth > new Date(now()).toISOString().slice(0, 10)) fields.dateOfBirth = 'Cannot be in the future';
    if (body.postcode !== undefined && (typeof body.postcode !== 'string' || !POSTCODE.test(body.postcode))) fields.postcode = 'Must be a UK postcode in the format "SW1A 1AA"';
    if (body.phone !== undefined && !text(body.phone, 30)) fields.phone = '1-30 characters';
    if (body.guardian !== undefined) {
      const g = body.guardian;
      if (typeof g !== 'object' || g === null || !text(g.name, 100) || !text(g.phone, 30)) fields.guardian = 'Must be { name, phone }';
    }
    if (!text(body.source, 50)) fields.source = 'Required';
    if (body.sourceRef !== undefined && !text(body.sourceRef, 100)) fields.sourceRef = '1-100 characters';
    return fields;
  }

  function validateBooking(body, extra) {
    const fields = checkUnknownFields(body, BOOKING_FIELDS, extra);
    if (typeof body.memberId !== 'string' || !members.has(body.memberId)) fields.memberId = 'Required, must be an existing member id';
    // Date.parse alone isn't enough: it rolls impossible dates such as 2025-02-29 over to 1 March.
    if (typeof body.sessionStart !== 'string' || !ISO_DATETIME.test(body.sessionStart) || !isCalendarDate(body.sessionStart.slice(0, 10)) || Number.isNaN(Date.parse(body.sessionStart))) fields.sessionStart = 'Required, ISO 8601 date-time with a time zone';
    if (!SESSION_TYPES.includes(body.sessionType)) fields.sessionType = `Required, one of: ${SESSION_TYPES.join(', ')}`;
    if (!Number.isInteger(body.amountPence) || body.amountPence < 0 || body.amountPence > 1_000_000) fields.amountPence = 'Required, whole number of pence from 0 to 1000000';
    if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > 500)) fields.notes = 'At most 500 characters';
    if (!text(body.source, 50)) fields.source = 'Required';
    if (body.sourceRef !== undefined && !text(body.sourceRef, 100)) fields.sourceRef = '1-100 characters';
    return fields;
  }

  function assertValid(fields) {
    if (Object.keys(fields).length > 0) {
      throw new ApiError(422, 'validation_failed', 'The request has invalid fields', fields);
    }
  }

  // ---- operations --------------------------------------------------------

  function upsertMember(body, extra = []) {
    assertValid(validateMember(body, extra));
    // Members are matched on exact email (case-sensitive).
    const existingId = membersByEmail.get(body.email);
    if (existingId) return { status: 200, body: { id: existingId, created: false } };
    const id = `mem_${randomUUID().slice(0, 12)}`;
    const member = { id, createdAt: new Date(now()).toISOString() };
    for (const key of MEMBER_FIELDS) if (body[key] !== undefined) member[key] = body[key];
    members.set(id, member);
    membersByEmail.set(body.email, id);
    return { status: 201, body: { id, created: true } };
  }

  function createBooking(body, idempotencyKey, extra = []) {
    if (idempotencyKey !== undefined) {
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 255) {
        throw new ApiError(400, 'bad_idempotency_key', 'Idempotency key must be 1-255 characters');
      }
      const { idempotencyKey: _, ...withoutKey } = body;
      const fingerprint = JSON.stringify(withoutKey);
      const previous = idempotency.get(idempotencyKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          throw new ApiError(409, 'idempotency_conflict', 'This idempotency key was already used for a different booking');
        }
        stats.idempotentReplays++;
        return { status: previous.status, body: previous.body, replayed: true };
      }
      const result = createBookingNow(body, extra);
      idempotency.set(idempotencyKey, { fingerprint, ...result });
      return result;
    }
    return createBookingNow(body, extra);
  }

  function createBookingNow(body, extra) {
    assertValid(validateBooking(body, extra));
    const id = `bkg_${randomUUID().slice(0, 12)}`;
    const booking = { id, createdAt: new Date(now()).toISOString() };
    for (const key of BOOKING_FIELDS) if (body[key] !== undefined) booking[key] = body[key];
    bookings.set(id, booking);
    return { status: 201, body: { id } };
  }

  function runBatch(items, run) {
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BATCH) {
      throw new ApiError(422, 'validation_failed', `Batch must contain 1-${MAX_BATCH} items`);
    }
    const results = items.map((item, index) => {
      try {
        if (typeof item !== 'object' || item === null) throw new ApiError(422, 'validation_failed', 'Item must be an object');
        const result = run(item);
        return { index, status: result.status, ...result.body };
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        if (err.status === 422) stats.validationErrors++;
        return { index, status: err.status, error: { code: err.code, message: err.message, fields: err.fields } };
      }
    });
    return { status: 200, body: { results } };
  }

  // ---- HTTP --------------------------------------------------------------

  function sendJson(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new ApiError(413, 'too_large', 'Request body too large');
      chunks.push(chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('not an object');
      return body;
    } catch {
      throw new ApiError(400, 'bad_json', 'Body must be a JSON object');
    }
  }

  function isRateLimited() {
    const t = now();
    recentRequests = recentRequests.filter((at) => t - at < 1000);
    if (recentRequests.length >= RATE_LIMIT_PER_SECOND) return true;
    recentRequests.push(t);
    return false;
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (req.headers['x-api-key'] !== apiKey) {
      return sendJson(res, 401, { error: { code: 'unauthorised', message: 'Missing or invalid x-api-key' } });
    }

    // Interviewer and debugging endpoints: never rate-limited.
    if (req.method === 'GET' && path === '/stats') {
      return sendJson(res, 200, { members: members.size, bookings: bookings.size, ...stats, chaos });
    }
    if (req.method === 'POST' && path === '/reset') {
      members.clear();
      membersByEmail.clear();
      bookings.clear();
      idempotency.clear();
      Object.assign(stats, emptyStats());
      return sendJson(res, 200, { status: 'reset' });
    }
    if (req.method === 'GET' && path === '/members') {
      const email = url.searchParams.get('email');
      const list = [...members.values()].filter((m) => email === null || m.email === email);
      return sendJson(res, 200, { members: list });
    }
    if (req.method === 'GET' && path === '/bookings') {
      const memberId = url.searchParams.get('memberId');
      const list = [...bookings.values()].filter((b) => memberId === null || b.memberId === memberId);
      return sendJson(res, 200, { bookings: list });
    }

    if (req.method !== 'POST') {
      return sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } });
    }

    stats.requests++;
    if (chaos) {
      if (isRateLimited()) {
        stats.rateLimited++;
        return sendJson(res, 429, { error: { code: 'rate_limited', message: `Rate limit is ${RATE_LIMIT_PER_SECOND} requests per second` } }, { 'retry-after': '1' });
      }
      if (random() < SLOW_RESPONSE_RATE) {
        stats.slowResponses++;
        await new Promise((resolve) => setTimeout(resolve, SLOW_RESPONSE_MS));
      }
      if (random() < SERVER_ERROR_RATE) {
        stats.serverErrors++;
        return sendJson(res, 500, { error: { code: 'internal', message: 'Internal server error' } });
      }
    }

    const body = await readJson(req);
    const idempotencyKey = req.headers['idempotency-key'];
    let result;
    if (path === '/members') result = upsertMember(body);
    else if (path === '/bookings') result = createBooking(body, idempotencyKey);
    else if (path === '/members/batch') result = runBatch(body.members, (item) => upsertMember(item));
    else if (path === '/bookings/batch') {
      result = runBatch(body.bookings, (item) => {
        const { idempotencyKey: key, ...booking } = item;
        return createBooking(booking, key);
      });
    } else return sendJson(res, 404, { error: { code: 'not_found', message: 'Not found' } });

    return sendJson(res, result.status, result.body, result.replayed ? { 'idempotent-replayed': 'true' } : {});
  }

  return async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 422) stats.validationErrors++;
        return sendJson(res, err.status, { error: { code: err.code, message: err.message, fields: err.fields } });
      }
      console.error(err);
      return sendJson(res, 500, { error: { code: 'internal', message: 'Internal server error' } });
    }
  };
}

// Start the server when run directly (npm run crm).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const apiKey = process.env.CRM_API_KEY;
  if (!apiKey) {
    console.error('Set CRM_API_KEY in .env first (any value works locally).');
    process.exit(1);
  }
  const port = Number(process.env.CRM_PORT ?? 4010);
  const chaos = process.env.MOCK_CRM_CHAOS !== 'off';
  createServer(createMockCrm({ apiKey, chaos })).listen(port, () => {
    console.log(`Mock CRM listening on http://localhost:${port} (failure modes ${chaos ? 'ON' : 'OFF'})`);
  });
}
