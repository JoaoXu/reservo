# Reservo: notes for Claude Code

Read this first. It is the context from the planning conversation, so work can
continue here without re-explaining.

## What this is

A multi-tenant SaaS for small massage studios in Portugal (Lisbon first): each
studio gets its own website + online booking + MB WAY / Multibanco / card
deposits (via the studio's own ifthenpay contract) + WhatsApp/SMS/email
reminders + an owner dashboard. Sold for €29–39/month, no commission, set up
for the studio by the founder. "Reservo" is a working name; the demo studio is
the fictional "Maré" in Alfama.

The founder is a DevOps engineer building this as a side business. Prefer
explaining infrastructure choices briefly and letting them decide; they know
the tooling.

## Run, test, check

```bash
npm install
cp .env.example .env
createdb reservo && createdb reservo_test
npm run migrate
npm run seed:demo -- localhost --with-bookings
npm run dev                 # http://localhost:3000, dashboard /admin (demo@reservo.pt / mare-demo-2026)
npm test                    # unit + integration (needs Postgres, uses reservo_test and wipes it)
npm run typecheck
```

Local Postgres: `docker compose up -d db` (password `reservo`, so `.env` has
`DATABASE_URL=postgres://postgres:reservo@127.0.0.1:5432/reservo`). `npm test`
doesn't load `.env`: pass
`DATABASE_URL=postgres://postgres:reservo@127.0.0.1:5432/reservo_test`.

Postgres 14+ with `btree_gist` (bundled with Postgres). Node 22.18+ runs the
TypeScript directly: there is no build step.

## Code conventions

- TypeScript with Node's type stripping: **erasable syntax only** (no enums,
  namespaces, parameter properties). Relative imports end in `.ts`.
- One runtime dependency (`postgres`). Don't add frameworks or packages
  without a clear reason; ask first.
- Every query is a `sql` tagged template (parameterised). Every table is
  scoped by `tenant_id`; new tables need it plus composite foreign keys
  `(tenant_id, id)` like the existing ones.
- Server HTML goes through the `html` tagged template (auto-escaping). Browser
  JS builds DOM with `textContent`, never `innerHTML` with data.
- CSP forbids inline scripts and inline `style=""`; per-page styles use the
  nonce'd `<style>` block (see `web/admin/bookings.ts` agenda).
- All customer-facing strings live in `src/lib/i18n.ts` in pt and en; the
  dashboard uses `tr(l, pt, en)`.
- Money is integer cents. Times are stored UTC and converted with
  `src/lib/time.ts` (Europe/Lisbon, DST-safe).
- Payment outcomes always go through `settlePayment` / `applyPaymentOutcome`
  (idempotent). Never update payment or booking status around it.
- Schema changes: add a new `migrations/00N_*.sql`; never edit an applied one.
  Keep migrations additive so old and new app versions can run together.
- Run `npm test` and `npm run typecheck` before calling anything done.

Map: `src/domain/` (bookings, availability, payments/ifthenpay, notify, jobs),
`src/web/` (site, booking flow, hooks, admin), `src/http/` (router, sessions,
rate limits), `docs/` (ARCHITECTURE, DEPLOY, ONBOARDING).

## Current status (23 Oct 2026)

Done and tested locally: template, booking engine (DB exclusion constraint
prevents double bookings), ifthenpay MB WAY/Multibanco/card client and
webhooks, mock gateway for demos, owner dashboard, reminders job, RGPD
export/erasure, Dockerfile, docker-compose, CI workflow, GCP Terraform
(`deploy/gcp/`), static demo export (`npm run demo:export`).

**Deployed on AWS** (20 Oct 2026): `deploy/aws/`, demo studio live at
http://reservo-750414086.eu-west-1.elb.amazonaws.com (image `d2e0252`).

Not yet done / not verified:
- **Never run against the real ifthenpay API.** Needs the founder's own
  ifthenpay contract and keys (MB WAY, MB KEY, CCARD KEY, anti-phishing key).
  Multibanco sandbox endpoint (`IFTHENPAY_MB_SANDBOX=true`) is assumed to be
  `/multibanco/reference/sandbox`; confirm with ifthenpay support.
- **No domain / HTTPS yet.** On the ALB hostname the demo's simulated card
  payment and "manage booking" links point at `https://mare.<PLATFORM_DOMAIN>`
  and don't resolve; MB WAY / Multibanco demo flows work.
- **Deploys are manual** (`make release`); `ci.yml` still pushes to GHCR only.
- WhatsApp (Meta Cloud API) and Brevo are written but untested; they default
  to `log` (print only).

## AWS deployment (how it is set up)

Decisions made by the founder: AWS for portfolio value; region `eu-west-1`;
no NAT gateway (tasks in public subnets with a public IP, SG accepts only the
ALB); plain HTTP on the ALB until a domain is bought; alarms to the founder's
email via SNS. Budget about €50–60/month; estimate ~$56.

- ECS Fargate ARM64 (0.25 vCPU / 512 MB, 1 task) behind an ALB, health check
  `/healthz`, circuit breaker with rollback. ECR tags are immutable git SHAs;
  build with `--provenance=false` (ECR rejects the attestation index).
- RDS Postgres 16 `db.t4g.micro`, private subnets, encrypted, 7-day backups,
  deletion protection + `prevent_destroy`, `sslmode=require`.
- Secrets Manager: `reservo/DATABASE_URL`, `reservo/DATA_ENCRYPTION_KEY`,
  `reservo/CRON_SECRET`.
- Background jobs run in the web task (`INLINE_WORKER=true`) because
  EventBridge API destinations need HTTPS. `https.tf` switches on the ACM
  certificate, :443, the :80 redirect and the EventBridge cron via
  `domain_name` then `https_enabled`.
- State: S3 bucket `reservo-tfstate-847047140632` (created by
  `deploy/aws/bootstrap/`), native lockfile.
- Credentials: Terraform 1.10's S3 backend can't read `aws login` sessions;
  use a `credential_process` profile (see `deploy/aws/README.md`). Call AWS
  CLI v2 as `/opt/homebrew/bin/aws`: a pyenv CLI v1 shim shadows it.
- Operating it: `deploy/aws/README.md` and the `Makefile` (`release`, `migrate`,
  `seed`, `smoke`).

## Next candidates

- Pick the name, buy the domain, turn on HTTPS (`https.tf`), re-run the seed.
- GitHub Actions deploy to AWS with OIDC (no stored keys): push to ECR, run
  the migrate task, update the service on merges to `main`.
- Before the first paying studio: ifthenpay sandbox test, an RDS restore
  test, decide on Multi-AZ (~€14/month).

## Safety rules for infrastructure work

- Show the `terraform plan` summary and wait for the founder's OK before every
  `apply`. Never run `terraform destroy`, delete RDS instances or snapshots,
  or delete S3 buckets/Secrets without being asked explicitly.
- Never print secret values in the chat or commit them. Use Secrets Manager
  and `random_password`; `.env` stays out of git.
- Use the founder's AWS SSO / `aws login` session. Don't create IAM users or
  long-lived access keys.
- Back up `DATA_ENCRYPTION_KEY` outside Terraform state as well: losing it
  means every studio re-enters its payment keys.
- Mention cost whenever a resource adds more than ~€5/month.

## Open business decisions (ask, don't assume)

- Final product name and domain.
- Pricing: two plans (€29 / €39) or one at €35. The business plan lives in
  the Claude Docs document "Reservo Business Plan"; the pitch deck is
  "Reservo Pitch".
- Founding partner terms: 1 month free, €25/month for life, first 5 studios.
