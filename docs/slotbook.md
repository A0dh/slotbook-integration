# SlotBook developer documentation (excerpt)

SlotBook is an online booking platform for leisure venues. Venues receive bookings by **webhook** as they
happen, and can download a **CSV export** of historical bookings from the SlotBook dashboard.

*SlotBook is fictional. These docs were written for this exercise.*

## Webhooks

SlotBook sends an HTTP `POST` with a JSON body to the URL the venue registers, for each event.

### Events

Only one event type is relevant here: `booking.created`.

```json
{
  "id": "evt_0000003dd3b1",
  "type": "booking.created",
  "createdAt": "2026-11-20T10:00:00Z",
  "data": {
    "bookingId": "SB-150001",
    "session": { "start": "2026-11-29T18:00:00Z", "type": "bouldering" },
    "climber": {
      "firstName": "Jane",
      "lastName": "Smith",
      "email": "jane.smith@example.com",
      "dateOfBirth": "1988-06-21",
      "postcode": "LS6 2AB",
      "guardian": null
    },
    "amountPence": 1250,
    "notes": ""
  }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Unique per event. |
| `type` | string | `booking.created` |
| `createdAt` | string | ISO 8601, UTC. |
| `data.bookingId` | string | Unique per booking. |
| `data.session.start` | string | ISO 8601, UTC. |
| `data.session.type` | string | `bouldering`, `top-rope`, `lead`, `course` or `other`. |
| `data.climber.firstName`, `lastName` | string | As typed by the climber. |
| `data.climber.email` | string | As typed by the climber. SlotBook does not verify it. |
| `data.climber.dateOfBirth` | string | `YYYY-MM-DD`. |
| `data.climber.postcode` | string | As typed by the climber. Optional. |
| `data.climber.guardian` | object or null | `{ "name", "phone" }`. Most venues require a guardian contact for climbers under 18, but SlotBook doesn't enforce it. |
| `data.amountPence` | integer | Amount paid, in pence. |
| `data.notes` | string | Free text from the climber. Up to 10,000 characters. |

SlotBook may add new fields at any time. Ignore fields you don't recognise.

### Delivery and retries

- Respond with any `2xx` status within **10 seconds** to acknowledge an event.
- If SlotBook doesn't get a `2xx` in time, it retries with backoff for up to 24 hours.
- SlotBook may occasionally deliver the **same event more than once**. Use `id` (or `data.bookingId`) to
  detect repeats.

### Signatures

Every webhook includes a `SlotBook-Signature` header:

```
SlotBook-Signature: t=1763632800,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
```

- `t` is the time the webhook was sent, in Unix seconds.
- `v1` is the hex-encoded HMAC-SHA256 of the string `<t>.<raw request body>`, using the venue's webhook
  signing secret as the key.

To verify a webhook:

1. Take `t` and `v1` from the header.
2. Compute the HMAC-SHA256 of `t`, a full stop, and the **raw request body exactly as received**, with your
   signing secret.
3. Compare your result with `v1` using a constant-time comparison.
4. Reject webhooks whose `t` is more than 5 minutes from the current time, to limit replay attacks.

For local development, choose any value as the secret and set it as `SLOTBOOK_WEBHOOK_SECRET` (the sample
sender in this repo uses that variable).

## CSV export

Venues can export historical bookings from the dashboard. One row per booking.

| Column | Notes |
| --- | --- |
| `booking_id` | Same as `data.bookingId` in webhooks. |
| `created_at` | When the booking was made. |
| `session_start` | When the session starts. |
| `session_type` | As in webhooks. |
| `first_name`, `last_name`, `email`, `postcode` | As typed by the climber. |
| `date_of_birth` | Date of birth. |
| `guardian_name`, `guardian_phone` | Empty when not provided. |
| `amount_pence` | Amount paid, in pence. |
| `notes` | Free text from the climber. |
| `internal_score` | Used by SlotBook internally. |

Dates and times in the export are ISO 8601. Exports covering bookings from before our platform migration
in March 2024 may use an older format for some columns.
