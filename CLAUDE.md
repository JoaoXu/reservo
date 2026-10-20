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

## Current status (20 Oct 2026)

Done and tested locally: template, booking engine (DB exclusion constraint
prevents double bookings), ifthenpay MB WAY/Multibanco/card client and
webhooks, mock gateway for demos, owner dashboard, reminders job, RGPD
export/erasure, Dockerfile, docker-compose, CI workflow, GCP Terraform
(`deploy/gcp/`), static demo export (`npm run demo:export`).

Not yet done / not verified:
- **Never run against the real ifthenpay API.** Needs the founder's own
  ifthenpay contract and keys (MB WAY, MB KEY, CCARD KEY, anti-phishing key).
  Multibanco sandbox endpoint (`IFTHENPAY_MB_SANDBOX=true`) is assumed to be
  `/multibanco/reference/sandbox`; confirm with ifthenpay support.
- **Not deployed anywhere.** AWS chosen as the target (see below).
- `package-lock.json` doesn't exist yet: commit it after the first `npm install`.
- WhatsApp (Meta Cloud API) and Brevo are written but untested; they default
  to `log` (print only).

## Next task: deploy to AWS

Decision: AWS (portfolio value for the founder's DevOps job search). Region
`eu-south-2` (Spain) unless the founder says otherwise. Budget target about
€50–60/month at launch.

Build `deploy/aws/` in Terraform, mirroring `deploy/gcp/main.tf`:
- VPC with 2 AZs; public subnets for the ALB, private subnets for app and DB.
  To save cost, avoid NAT Gateways: give tasks public IPs in public subnets
  with tight security groups, or use VPC endpoints; explain the trade-off and
  let the founder pick.
- ECR repository; ECS Fargate service (0.25 vCPU / 512 MB, min 1 task) behind
  an ALB, health check `/healthz`, `TRUST_PROXY_HOPS=1`.
- RDS PostgreSQL 16 `db.t4g.micro`, encrypted, private, 7-day backups,
  deletion protection on, security group allowing 5432 only from the service.
- Secrets Manager for `DATABASE_URL`, `DATA_ENCRYPTION_KEY`, `CRON_SECRET`,
  injected as ECS task secrets.
- One-off ECS task definition for migrations (`node scripts/migrate.ts`).
- EventBridge Scheduler every minute → `POST /internal/cron` with the bearer
  token (or a second small ECS service running `node src/worker.ts`; cheaper
  to use the scheduler). Set `INLINE_WORKER=false`.
- ACM certificate + HTTPS listener once a domain exists; until then HTTP on
  the ALB DNS name is fine for testing, with `PUBLIC_BASE_URL` set to it.
- CloudWatch log group (30-day retention) and an alarm on 5xx / unhealthy
  targets, notifying the founder's email via SNS.
- Remote state in S3 with locking.
- A `Makefile` or `deploy/aws/README.md` with: build + push image, run
  migrations task, update service, seed demo.

Then: deploy, run migrations, `seed-demo.ts` with the ALB hostname as an
extra domain, and smoke-test `/healthz`, `/`, `/marcar`, `/admin`.

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
