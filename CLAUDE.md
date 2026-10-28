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
  Integration tests hit a real Postgres and real HTTP (`call()` helper in
  `test/integration.test.ts`), store media in a temp folder, and build test
  images with `test/helpers/images.ts`. New tenant-scoped features get a
  cross-tenant isolation test.
- **Public site content is versioned** (`src/domain/sites.ts`): edits go to a
  draft in `site_versions`; publishing copies name/content/theme/site into
  `tenants`, which always holds the published version (everything else reads
  the tenant). Never write those four tenant columns directly.
- **Business-type wording** (massage/salon/barber/beauty): `tb(l, type, key)`
  looks up `key@type` in `i18n.ts`, falling back to `key` (massage wording).
  In the dashboard use `staffWord(ctx)`, never a hard-coded "Terapeuta".
- **Businesses are set up from client files** (`clients/<slug>.json`,
  `src/domain/provision.ts`, `npm run tenant:apply`): idempotent, matched by
  name, missing services/staff deactivated. The demos are fictional and must
  always work end to end: Maré (massage, Classic template) and Navalha
  (barbershop in Porto, Studio template); `npm run seed:demo` resets both.
- **Images come only from the business's own library** (`src/domain/media.ts`):
  stored at `t/<tenant_id>/<file>` (local folder in dev/tests, S3 + CloudFront
  in production); site JSON keeps file names only, URLs are built with the
  tenant's own id; staff photos have a composite FK. Uploads are checked by
  content and stripped of metadata (`src/lib/images.ts`); S3 calls are signed
  by hand (`src/lib/sigv4.ts`, tested against the AWS example). CSP `img-src`
  is `'self' data:` plus the media origin: no external image links.
- **Design is curated** (`src/domain/design.ts`): templates, font pairings and
  preset palettes. Every palette, preset or custom, must pass the contrast
  rules (4.5:1); Studio CSS never puts accent-coloured text on ink.

Map: `src/domain/` (bookings, availability, payments/ifthenpay, notify, jobs,
sites, design, media, provision), `src/lib/` (i18n, images, sigv4, time,
crypto), `src/web/` (site, booking flow, hooks, admin), `src/http/` (router,
sessions, rate limits, CSP), `clients/` (one JSON file per business + photos),
`docs/` (ARCHITECTURE, DEPLOY, ONBOARDING, **PROJECT_STATUS**, **NEXT_STEPS**).

Start a session by reading `docs/PROJECT_STATUS.md` (what is built, deployed
and known broken) and `docs/NEXT_STEPS.md` (prioritised work). Keep both
current when a phase ships.

## Current status (28 Oct 2026)

Done and tested locally: template, booking engine (DB exclusion constraint
prevents double bookings), ifthenpay MB WAY/Multibanco/card client and
webhooks, mock gateway for demos, owner dashboard, reminders job, RGPD
export/erasure, Dockerfile, docker-compose, CI workflow, GCP Terraform
(`deploy/gcp/`, not kept in step since the AWS move: no media storage),
static demo export (`npm run demo:export`). 40 tests, typecheck clean.

**Deployed on AWS** since 20 Oct 2026 (`deploy/aws/`). Platform phases 1–3
are live: image `ed76c0d`, ECS task definition `reservo:5`, migrations up to
`004`. Test domain: platform host https://app.reservo.joaoxu.dev, demos
https://mare.reservo.joaoxu.dev and https://navalha.reservo.joaoxu.dev, images
from https://media.reservo.joaoxu.dev. `joaoxu.dev` is the founder's personal
domain (registrar Namecheap, DNS delegated to Route 53), used only for testing
until the product name and domain are decided.

Not yet done / not verified:
- **Never run against the real ifthenpay API.** Needs the founder's own
  ifthenpay contract and keys (MB WAY, MB KEY, CCARD KEY, anti-phishing key).
  Multibanco sandbox endpoint (`IFTHENPAY_MB_SANDBOX=true`) is assumed to be
  `/multibanco/reference/sandbox`; confirm with ifthenpay support.
- **Deploys are manual** (`make release`); `ci.yml` still pushes to GHCR only.
- WhatsApp (Meta Cloud API) and Brevo are written but untested; they default
  to `log` (print only).

## AWS deployment (how it is set up)

Decisions made by the founder: AWS for portfolio value; region `eu-west-1`;
no NAT gateway (tasks in public subnets with a public IP, SG accepts only the
ALB); alarms to the founder's email via SNS. Budget about €50–60/month;
estimate ~$56 plus $0.50 for the Route 53 zone.

- ECS Fargate ARM64 (0.25 vCPU / 512 MB, 1 task) behind an ALB, health check
  `/healthz`, circuit breaker with rollback. ECR tags are immutable git SHAs;
  build with `--provenance=false` (ECR rejects the attestation index).
- RDS Postgres 16 `db.t4g.micro`, private subnets, encrypted, 7-day backups,
  deletion protection + `prevent_destroy`, `sslmode=require`.
- Secrets Manager: `reservo/DATABASE_URL`, `reservo/DATA_ENCRYPTION_KEY`,
  `reservo/CRON_SECRET`.
- HTTPS (`https.tf`): ACM wildcard certificate, :443 listener, :80 redirects.
  Route 53 zone `joaoxu.dev` (`route53_zone`) holds the validation CNAME and
  `*.reservo.joaoxu.dev` -> ALB. Switching to the real domain later: change
  `domain_name` / `route53_zone`, apply, delegate, then `https_enabled`.
- Background jobs: EventBridge rule every minute -> API destination
  `POST https://app.reservo.joaoxu.dev/internal/cron` (`INLINE_WORKER=false`).
- State: S3 bucket `reservo-tfstate-847047140632` (created by
  `deploy/aws/bootstrap/`), native lockfile.
- Credentials: Terraform 1.10's S3 backend can't read `aws login` sessions;
  use a `credential_process` profile (see `deploy/aws/README.md`). Call AWS
  CLI v2 as `/opt/homebrew/bin/aws`: a pyenv CLI v1 shim shadows it.
- Operating it: `deploy/aws/README.md` and the `Makefile` (`release`, `migrate`,
  `seed`, `smoke`).
- Release order (what `make release` does; keep it when running by hand):
  commit → build and push the image tagged with the short SHA → plan and get
  the founder's OK → targeted apply of `aws_ecs_task_definition.migrate` →
  `./run-task.sh` (migrations) → re-plan, check it matches what was approved,
  full apply → `aws ecs wait services-stable` → `make seed
  SEED_ARGS=--with-bookings` if demo data changed → smoke test.
- Media (`media.tf`): bucket `reservo-media-847047140632`, CloudFront
  `E1HIVNIBAF98IP` with a us-east-1 certificate (provider alias `us_east_1`),
  task role `reservo-ecs-task` may only put/delete `t/*`. The app gets
  credentials from the ECS container endpoint; there are no keys anywhere.
- Local-only files that matter (git-ignored, not backed up by the repo):
  `deploy/aws/terraform.tfvars`, `deploy/aws/bootstrap/terraform.tfstate`
  (state of the state bucket), `.env`.

## Platform roadmap (agreed 27 Oct 2026)

Goal: dozens of appointment businesses (massage, salons, barbers, beauty) on
one deployment, each with its own website and, later, its own domain.
Restaurants are out of scope for now (different booking model).
Decisions: one shared database with `tenant_id` everywhere (no per-tenant
DBs); custom domains via **option A**: one ACM certificate per domain on the
ALB, the client's DNS in Route 53 (we register or take over their domain),
platform subdomain kept as preview/fallback; S3 access signed by hand with
`node:crypto` (no AWS SDK) unless the founder says otherwise.

1. **Done (27 Oct):** business types, client files + `tenant:apply`, site
   versions with draft/preview/publish/rollback, Site page in the dashboard,
   section visibility/order. Also fixed: "any therapist" bookings could fail
   with a deadlock (40P01) under concurrency; now retried.
2. **Done (28 Oct):** Classic and Studio templates (CSS over shared
   sections), gallery/testimonials/FAQ sections and editors, six palettes plus
   custom colours with a WCAG contrast check, two font pairings, English
   service categories, the Navalha barbershop demo. (The interim gallery
   https links were replaced by the photo library in phase 3.)
3. **Done (28 Oct):** photo library (`media` table, Fotos page, uploads resized
   and GPS-stripped in the browser, re-checked and stripped on the server),
   logo, cover photo, gallery and team photos from the library, client files
   upload photos next to them, private S3 bucket + CloudFront at
   `media.reservo.joaoxu.dev` (`deploy/aws/media.tf`), ECS task role limited to
   put/delete under `t/*`, S3 gateway endpoint, CSP without `https:` images.
   Demo photos are Unsplash (see `clients/CREDITS.md`). No server-side
   resizing/thumbnails yet (would need `sharp` or an image CDN).
4. Custom domains: domains map in Terraform (zone, cert, alias apex + www,
   listener certificate), domain status pending -> active, `tenant:domain`
   command, primary-domain redirect. Only the platform admin attaches domains.
5. Hardening: Postgres row-level security; ignore client `X-Forwarded-Host`
   behind the ALB (it passes the header through; matters once a cache sits in
   front); wider cross-tenant and caching tests.

Other open items: GitHub Actions deploy to AWS with OIDC; ifthenpay sandbox
test and an RDS restore test before the first paying business; Multi-AZ
(~€14/month); refund wording on cancelled bookings (refunds are manual in
ifthenpay).

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
