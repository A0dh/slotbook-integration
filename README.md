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
