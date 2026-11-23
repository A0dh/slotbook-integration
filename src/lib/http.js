// Helpers for Node's built-in HTTP server.

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message safe to show to the caller
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Reads the raw request body as a Buffer, refusing anything over the limit.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limitBytes]
 * @returns {Promise<Buffer>}
 */
export async function readBody(req, limitBytes = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Parses a JSON body, turning bad JSON into a 400.
 * @param {Buffer} body
 */
export function parseJsonBody(body) {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body is not valid JSON');
  }
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
export function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} html
 */
export function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

/**
 * Escapes text for safe use inside HTML.
 * @param {unknown} value
 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
