# Reservo

A reusable website + online booking + payments product for massage studios
and spas in Portugal. One deployment serves every studio: each gets its own
site on its own domain, with treatments and prices, team, opening hours,
online booking, MB WAY / Multibanco / card deposits through the studio's own
ifthenpay account, confirmation and reminder messages, and an owner dashboard
that works on a phone.

The demo studio, **Maré** (Lisbon), is fictional: it is the template for new
businesses (`clients/mare.json`) and is seeded with `npm run seed:demo`.

## What's included

| Area | What it does |
|---|---|
| Studio site | Home page with live "next openings", treatment menu, team, hours, map and contacts; privacy and cancellation pages; Livro de Reclamações link. Portuguese and English, auto-picked for tourists. |
| Booking | Treatment → therapist (or "no preference") → day and time → details → payment. Slots come from each therapist's weekly hours, time off, existing bookings and clean-up buffers, with Lisbon daylight-saving handled. |
| No double bookings | A Postgres exclusion constraint makes overlapping bookings for one therapist impossible, even with many app instances. "No preference" picks the least busy free therapist. |
| Payments | ifthenpay MB WAY (push to the customer's phone), Multibanco references, and card. Deposit (%), full payment or none. Unpaid bookings hold the slot for a set time, then free it. Late payments re-instate the booking or alert the owner. A mock gateway powers demos. |
| Messages | Confirmation, Multibanco reference, 24 h reminder, cancellation, owner alerts. WhatsApp (Meta Cloud API templates) or SMS, plus email (Brevo). |
| Customer self-service | Private link to view, add to calendar (.ics) or cancel within the studio's window. |
| Owner dashboard | Day agenda per therapist, booking list and search, phone/WhatsApp bookings, record cash/terminal payments, no-shows, treatments, team and weekly hours, time off, site texts and colours, booking rules, payment keys, customers with CSV export and erasure. |
| Ops | Health checks, JSON logs, background jobs safe to run on many replicas, migrations with locking, Dockerfile, docker-compose, CI, Terraform for Google Cloud. |

## Run it locally

Requirements: Node.js 22.18+ and PostgreSQL 14+ (with the `btree_gist` extension, which ships with Postgres).

```bash
npm install
cp .env.example .env              # defaults work for local development
createdb reservo
npm run migrate
npm run seed:demo -- localhost --with-bookings   # demo studio + sample bookings, on http://localhost:3000
npm run dev
```

- Site: http://localhost:3000
- Dashboard: http://localhost:3000/admin (`demo@reservo.pt` / `mare-demo-2026`)
- In demo mode, MB WAY approves itself after ~6 seconds (numbers ending in `0000` decline), the card page is a test page, and Multibanco references can be marked paid from the dashboard.

With Docker instead: `docker compose up --build`, then
`docker compose run --rm app node scripts/seed-demo.ts localhost` and open http://localhost:8080.

## Tests

```bash
createdb reservo_test
npm test           # unit tests + integration tests against Postgres and the real HTTP server
npm run typecheck
```

The integration tests cover concurrent double-booking attempts, the full
online booking flow, ifthenpay callbacks (anti-phishing key, amount check,
duplicate deliveries), signed MB WAY notifications, expired holds and late
payments, customer cancellation, CSRF and studio isolation in the dashboard.

## Adding a business

Each business is a client file: texts, look, services, team and hours.

```bash
cp clients/mare.json clients/casa-lotus.json   # edit it
npm run tenant:apply -- clients/casa-lotus.json --dry-run
npm run tenant:apply -- clients/casa-lotus.json
```

Then follow [docs/ONBOARDING.md](docs/ONBOARDING.md): file format, ifthenpay keys and callback, domain.

## Project layout

```
src/
  server.ts            HTTP server and routes
  worker.ts            background job loop (or use POST /internal/cron)
  config.ts            all settings, from environment variables
  domain/              bookings, availability, payments (ifthenpay), messages, jobs
  web/                 studio site, booking flow, webhooks, owner dashboard
  http/                routing, headers, sessions, rate limits
  lib/                 time zones, HTML escaping, crypto, validation, i18n
public/                CSS, browser JS, self-hosted fonts
migrations/            SQL schema
clients/               one JSON file per business (mare.json is the fictional demo)
scripts/               migrate, seed demo, apply client file, export static demo
deploy/aws/            Terraform: ECS Fargate + ALB + RDS + Route 53 (live)
deploy/gcp/            Terraform: Cloud Run + Cloud SQL + Secret Manager + Scheduler
docs/                  architecture, deployment, onboarding
```

Only one runtime dependency: the `postgres` driver. Node runs the TypeScript
sources directly, so there is no build step.

More: [Architecture and security](docs/ARCHITECTURE.md) · [Deployment](docs/DEPLOY.md) · [Onboarding a studio](docs/ONBOARDING.md)
