# Bramble Wall integrations

A small service that brings data from other systems into **Bramble Wall's** membership system (the
"CRM"). Bramble Wall is a fictional chain of climbing gyms, and everything in this repository (companies,
people, data) is made up for a technical exercise.

Your task is in the brief you were sent. This README explains how the existing code works and how to run it.

## Getting started

Requires **Node.js 22.9 or later**. There are no dependencies to install.

```bash
cp .env.example .env      # then fill in the blanks (any values work locally)
npm start                 # starts the mock CRM (port 4010) and the service (port 3000)
```

In a second terminal:

```bash
npm run import -- front-desk-waivers data/front-desk/waivers.csv   # a file import
npm run send-webhooks -- chalk-shop                               # sample webhooks
npm run import -- slotbook data/slotbook/backfill.csv             # SlotBook backfill
npm run send-webhooks -- slotbook                                 # SlotBook sample webhooks
npm run crm:stats                                                 # what the CRM received
npm test                                                          # tests (node:test)
```

You can also run the pieces separately: `npm run crm` and `npm run app`.

## How it fits together

```
 source ──► integration ──────────────────────────────► CRM
            refOf → map → validate → send
            (src/integrations/<name>/)    (src/pipeline/run.js)
```

- **`src/pipeline/`** is shared by every integration.
  - `run.js` takes records one at a time: **map** to the CRM's shape, **validate**, then **send**. Records that
    fail mapping or validation are *rejected*; records the CRM refuses are *failed*.
  - `summary.js` records what happened to each record, so staff can see what came through and why not.
  - `crm-client.js` talks to the CRM.
- **`src/integrations/`** has one folder per source. Each has a `map.js`, a `validate.js` and an `index.js`
  that ties them together and connects them to the outside world (a file or an HTTP route).
- **`src/app.js`** has the HTTP routes; **`src/cli.js`** has the file importers.
- **`mock-crm/`** is a stand-in for the real membership system. See `docs/crm-schema.md`.

### Existing integrations

| Integration | Source | Becomes |
| --- | --- | --- |
| `front-desk-waivers` | CSV export from the waiver tablet at reception | Members |
| `chalk-shop` | Webhook from the gym's online shop (`POST /webhooks/chalk-shop`) | Members and bookings |
| `slotbook` | Signed webhook (`POST /webhooks/slotbook`) and CSV export | Members and bookings |

## Data

| Path | What |
| --- | --- |
| `data/front-desk/waivers.csv` | A day's waiver export |
| `data/chalk-shop/webhooks/` | Sample Chalk Shop webhooks |
| `data/slotbook/webhooks/` | Sample SlotBook webhooks (`npm run send-webhooks -- slotbook`) |
| `data/slotbook/backfill.csv` | SlotBook's export of historical bookings (50,000 rows) |

All data is synthetic. Email addresses use the reserved `example.*` domains and phone numbers use Ofcom's
range for drama, so none belongs to a real person.

## Docs

- `docs/crm-schema.md`: the CRM's API.
- `docs/slotbook.md`: SlotBook's webhook and export formats, including how webhooks are signed.

## Configuration

All configuration is in environment variables, loaded from `.env` by the npm scripts. See `.env.example`.

---

# SlotBook integration

Live bookings arrive by signed webhook; historical ones come from SlotBook's CSV export. Both go through
the same pipeline and become a CRM member (created, or matched by email) and a booking.

## Running it

```bash
cp .env.example .env      # set SLOTBOOK_WEBHOOK_SECRET (any value locally); ANTHROPIC_API_KEY only for rules:suggest
npm start                 # mock CRM + service

npm run import -- slotbook data/slotbook/backfill.csv     # backfill, then prints the run summary
npm run send-webhooks -- slotbook                         # the 8 sample webhooks
npm run rules:suggest -- slotbook data/slotbook/backfill.csv   # AI-suggested cleaning rules, approved one by one
```

The approved rule set is committed in `config/rules/slotbook.json`, so the import and webhooks work without
an API key. Rejected and flagged webhooks are logged to `out/slotbook-webhooks.jsonl` (refs and reason codes only).

**Results** (50,000-row backfill into an empty mock CRM, chaos on): 49,752 imported, 248 rejected, 0 failed in about
110 s, riding out ~45 rate limits, ~20 server errors and ~10 slow responses. A second run creates nothing new
(49,752 idempotent replays). Without the approved rules, 3,376 are rejected: the extra 3,128 are pre-migration dates.

## How it fits the existing structure

Same shape as the existing integrations: `src/integrations/slotbook/` has `map.js`, `validate.js` and
`index.js` (route and importer), plus `signature.js` and `sender.js`. Additions to shared code are opt-in,
so the existing integrations are unchanged:

- `pipeline/run.js`: an integration may provide `sendBatch` instead of `send`; records are sent in chunks of 100.
- `pipeline/crm-client.js`: batch and lookup methods with retries. The existing single-record methods are untouched.
- `pipeline/summary.js`: flagged records and counts of cleaning rules applied.
- `src/rules/`: the cleaning-rule catalogue and the AI suggestion flow; `src/lib/validators.js`: shared checks.

```
webhook ─ signature ─┐
                     ├─► map (+ approved rules) ─► validate ─► sender: dedupe, identity & guardian, create or look up ─► CRM
CSV row ─────────────┘
```

## Decisions (where the brief and docs are silent)

**Webhook responses.** 401 for a bad signature (checked on the raw bytes, constant-time, ±5 minutes).
Other event types: 200 `ignored`. Imported **and rejected** bookings get 200, because retrying can't fix bad
data; rejections are logged for staff instead. 503 only when the CRM couldn't take the booking within
8 seconds, so SlotBook retries (safe, see duplicates).

**Duplicates.** Every booking is sent with the idempotency key `slotbook:<bookingId>`, so redelivered
webhooks and re-run imports create nothing new. The same booking id twice in one export: the first wins,
the rest are rejected `duplicate_booking`. A changed booking under an id the CRM already has: `conflicts_with_crm`.

**Identity.** The CRM matches email case-sensitively, so emails are always lower-cased (identity policy,
not an optional rule). The CRM never updates an existing member, so later changes (a new postcode) are not
applied. A climber is identified by email plus date of birth; names are not compared. Same email but a different
date of birth is a different person: rejected `identity_conflict` rather than attaching their booking to
someone else. This rejects families sharing one email (twins sharing one would merge); see next steps.

**Under-18s.** Age is taken at the session start. The guardian must be usable (a real name, not "N/A" or a
placeholder, and a 10–15 digit phone) and **on the CRM record the booking lands on**:
- a new member is created with the booking's guardian, or one the same climber (email + date of birth) gave
  on another booking in the export (flagged `guardian_recovered`); otherwise `guardian_required`, or
  `guardian_unusable` when one was given but can't be used;
- an existing member without a guardian: `guardian_not_on_crm_record`. We can't add one, since the CRM doesn't update members.

Dates of birth over 100 years before the session are taken as placeholders (e.g. 1900-01-01) and rejected:
they would make a child look like an adult.

**Messy data.** Imported but flagged for staff: an unfixable postcode or unusable guardian (dropped; the CRM
field is optional), notes over 500 characters (truncated), notes that look like a formula, markup or
instructions to an AI (kept as text), odd punctuation in names. Rejected: invalid or missing email, markup
or formulas in names or email, missing or impossible dates, unknown session type, bad amount. `created_at`
and `internal_score` are ignored.

**Pre-migration dates.** Some export rows use `DD/MM/YYYY` and `DD/MM/YYYY HH:mm`. They are read as
day-first (the data has days above 12) and times as UK local time, converted to UTC including the clock
changes: a time in the hour the clocks skip moves an hour on, and one in the hour that repeats is read as
GMT. Impossible dates and times (`31/02`, `25:00`) are left unconverted, so validation rejects them.

**Rejected vs failed.** *Rejected* means the data is the problem; it has a reason code in the summary.
*Failed* means the CRM couldn't take it. Re-running the import is safe and picks failed records up.

## The AI feature

`npm run rules:suggest` asks Claude which cleaning rules a source needs; a person approves each one before
it touches any data.

1. **Profile locally.** Each field's values become shapes: `O'NEILL` → `A'A`, `07700 900123` →
   `99999 999999`. Only shapes seen 5+ times are kept (rare ones are where personal data leaks), real values
   only for session type, and notes are left out. **No names, emails, dates of birth or phone numbers are
   sent**, only about 5 KB of shapes and counts.
2. **One request** to the Messages API, constrained by a JSON schema to known fields and to five operations
   defined in code (`lowercase`, `title_case`, `uk_postcode`, `uk_phone`, `uk_date`). The answer is
   checked again in code; invalid suggestions are dropped with a reason. Cost: one small request per run.
3. **Review.** For each suggestion: Claude's reason, how many records it would change and before → after
   examples from the real data. Answer y/n; only approved rules are written, with when and by which model.
4. **When the AI is slow (60 s), down, refuses or answers badly**, nothing is written and the current rules
   stay. Imports and webhooks never call the AI; they only read the approved file.

Rules can only switch on operations defined in code, so an approved rule can clean values but never relax
validation. The trade-off: Claude chooses which operations apply to which fields, but a new kind of
cleaning (say, US dates) still needs a developer to add an operation. I chose that over letting a model
write cleaning code, which a gym's staff couldn't review.

## Security and personal data

- Webhook signature checked before the body is parsed; body capped at 256 KB.
- All input is untrusted: wrong types become empty values for validation; unknown fields are dropped;
  formulas and markup are rejected in names and email, and flagged in notes; text printed to the
  terminal is stripped of control characters.
- Secrets come from environment variables only (`.env.example` updated). The Claude key is used only by
  the CLI and never reaches a browser or a log.
- Logs and the webhook log hold booking refs, reason codes and CRM field names, never member data.

## Performance and reliability

- Members and bookings are sent in batches of 100: about 1,000 write requests for the backfill.
- 429s wait for `Retry-After`; 5xx, network errors and timeouts back off with jitter; each attempt times out at 10 s.
- Members are created first and looked up only when the CRM says it already held the email, or when a booking
  was refused as new (an under-18 with no guardian). A fresh backfill needs almost no lookups; a re-run needs one
  per email. A member batch whose response was lost is retried into "already held", then checked, not failed.
- If the CRM is down, a chunk fails fast (reported, safe to re-run) instead of retrying record by record.

## Tests

A few tests for what matters most (`npm test`), not a full suite:
- all 8 sample webhooks give the predicted outcome, with no personal data in the log; bad signatures get 401;
  a CRM outage gets 503 so SlotBook retries;
- signature edge cases (re-serialised JSON, replay window);
- the guardian and identity decisions, including the 18th birthday; a re-send creates nothing new, a changed one is caught;
- validation policy for placeholder dates, formulas, unusable guardians;
- UK date conversion across clock changes and impossible times;
- 429 `Retry-After` and giving up after retries;
- the AI profile carries no values; every way the AI call can fail is caught with a clear error.

Before production I'd add: the full backfill against the mock in CI (counts as a regression check), a CRM
outage mid-import, concurrent webhooks for the same new member, and property tests for the mapping.

## Next steps

- **Families sharing an email**: import and flag for staff instead of rejecting as `identity_conflict`.
- **Member updates**: needs a CRM update endpoint; today later changes are not applied.
- **A durable queue for webhooks** the CRM couldn't take for longer than SlotBook's 24 hours of retries.
- **A staff page** for rejected and flagged records, with fix-and-retry; today they are in the summary and the webhook log.
- **Faster re-runs**: parallel lookups with a concurrency limit.
- **Rule review UX**: show the rules a new approval would remove; built-in suggestions when the AI is down.
- **Title case** gets `MCDONALD` → `Mcdonald`; names with prefixes need a list or human review.
- Data protection: retention for rejected data, and a processing agreement if more than shapes is ever sent to an AI.
- TypeScript and explicit dependency injection across the codebase.

## Notes on the existing code

Not fixed, as the brief asks:
- `src/integrations/front-desk-waivers/index.js:24` logs the whole member (personal data) on every send.
- `src/integrations/chalk-shop/index.js:25` creates bookings without an idempotency key, and the client's
  single-record methods retry only 429s, not 5xx or network errors; a retried webhook can create duplicate bookings.
- `src/integrations/chalk-shop/index.js:46` answers 422 to rejected webhooks; most senders treat 4xx as
  "retry" or "alert", though retrying can't fix the data.
- `src/lib/csv.js:52`: rows with too few or too many fields are padded or truncated silently, and an
  unclosed quote swallows the rest of the file.
- `src/integrations/chalk-shop/index.js:7` imports `config` as a singleton, which makes it hard to test;
  new code passes dependencies in.
- `src/pipeline/run.js` sends one record at a time, too slow for a 50,000-row backfill without batching.

## AI notes

I used Claude Code to write most of the code under my direction, and two other models (Claude Fable and
OpenAI's Codex) as independent reviewers of the plan, the code and the tests. I reviewed every change
and ran everything against the mock CRM.

Things AI got wrong, caught in review or testing:
- **The rule suggestions** (Claude via the feature itself) included `lowercase(email)`, which is redundant
  since mapping already lower-cases every email. I declined it.
- **A comment on the clock change** said ambiguous autumn times were read as the first occurrence (BST);
  the code reads the second (GMT). Fixed the comment.
- **The first guardian check** accepted "none" as a guardian's name. Added a placeholder list.
- **The review prompt** lost answers that were typed or pasted before the question appeared, so the
  approval step hung. Found in a dry run against the real API; fixed.
- **Impossible times** like `25:00` rolled into the next day instead of being rejected. Found by a reviewer model.
- **The first test suite was far too big** (around 70 tests); I cut it to a dozen that cover the decisions above.
