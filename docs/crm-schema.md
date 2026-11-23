# Membership system (CRM) API

Bramble Wall's membership system stores **members** and their **bookings**. In this repo it's provided as a
mock (`mock-crm/`) that runs locally on `http://localhost:4010` (`npm run crm`).

The mock behaves like a real third-party API: by default it rate-limits, occasionally fails, and is
occasionally slow. Set `MOCK_CRM_CHAOS=off` while you debug, and switch it back on for real runs.

## Authentication

Every request needs the header `x-api-key: <CRM_API_KEY>`. Otherwise: `401`.

## Members

### `POST /members`

Creates a member, or returns the existing member with the **exact same email** (the match is
case-sensitive).

| Field | Required | Format |
| --- | --- | --- |
| `firstName` | yes | 1–100 characters |
| `lastName` | yes | 1–100 characters |
| `email` | yes | A valid email address |
| `dateOfBirth` | yes | `YYYY-MM-DD`, a real date, not in the future |
| `postcode` | no | A UK-format postcode in capitals with one space, e.g. `SW1A 1AA` |
| `phone` | no | Up to 30 characters |
| `guardian` | no | `{ "name": string, "phone": string }` |
| `source` | yes | Which integration sent it, e.g. `front-desk-waivers` |
| `sourceRef` | no | The record's id in the source system |

Unknown fields are rejected.

Responses: `201 { "id", "created": true }` for a new member; `200 { "id", "created": false }` when the email
already exists (the existing member is not changed).

### `POST /members/batch`

`{ "members": [ ...up to 100 members... ] }` → `200 { "results": [ { "index", "status", "id"?, "created"?, "error"? } ] }`

Each item succeeds or fails on its own; `status` is what `POST /members` would have returned for it.

### `GET /members?email=<email>`

Lists members, optionally filtered by exact email.

## Bookings

### `POST /bookings`

| Field | Required | Format |
| --- | --- | --- |
| `memberId` | yes | An existing member's `id` |
| `sessionStart` | yes | ISO 8601 date-time with a time zone, e.g. `2026-11-29T18:00:00Z` |
| `sessionType` | yes | `bouldering`, `top-rope`, `lead`, `course` or `other` |
| `amountPence` | yes | Whole number from 0 to 1,000,000 |
| `notes` | no | Up to 500 characters |
| `source` | yes | Which integration sent it |
| `sourceRef` | no | The booking's id in the source system |

Unknown fields are rejected. Response: `201 { "id" }`.

**Idempotency.** Send an `Idempotency-Key` header (1–255 characters) to make a request safe to retry. A
repeated request with the same key returns the original response with `Idempotent-Replayed: true` and
creates nothing. Reusing a key for a *different* booking returns `409`.

### `POST /bookings/batch`

`{ "bookings": [ ...up to 100 bookings... ] }`. Each item may include an `idempotencyKey` field, which works
like the header. Response format as for `/members/batch`.

### `GET /bookings?memberId=<id>`

Lists bookings, optionally for one member.

## Errors

All errors are JSON: `{ "error": { "code", "message", "fields"? } }`.

| Status | Meaning |
| --- | --- |
| `400` | Body isn't a JSON object, or a bad idempotency key. |
| `401` | Missing or wrong API key. |
| `409` | Idempotency key reused for a different booking. |
| `413` | Body over 1 MB. |
| `422` | Validation failed; `fields` says which and why. |
| `429` | Rate limited. Wait for the number of seconds in the `Retry-After` header. |
| `500` | Something went wrong on the CRM's side. Usually worth retrying. |

**Rate limit:** 20 requests per second across all write endpoints. A batch counts as one request.

## Debugging

- `GET /stats`: counts of members, bookings, rate-limited requests, server errors and so on.
  `npm run crm:stats` prints it.
- `POST /reset`: clears everything. Data is in memory only, so restarting the mock also clears it.
