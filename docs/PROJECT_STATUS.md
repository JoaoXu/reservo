# Project status

Snapshot: **28 Oct 2026**. Update this file when a phase ships or a known
issue is fixed. Prioritised work is in [NEXT_STEPS.md](NEXT_STEPS.md); design
detail in [ARCHITECTURE.md](ARCHITECTURE.md).

## At a glance

| | |
|---|---|
| Last commit | `64c7b16` (docs), last code commit `ed76c0d` (phase 3); pushed to `origin/main` |
| Production | AWS eu-west-1, ECS task definition `reservo:5`, image `ed76c0d` |
| Schema | migrations `001`–`004` applied in production |
| Tests | 40 (21 unit, 19 integration), all passing; typecheck clean |
| Platform host | https://app.reservo.joaoxu.dev |
| Demos | https://mare.reservo.joaoxu.dev (massage, Classic), https://navalha.reservo.joaoxu.dev (barber, Studio) |
| Images | https://media.reservo.joaoxu.dev (CloudFront → private S3) |
| Paying businesses | none yet |

Demo logins are in the client files (`clients/*.json`, `owner` block): they
are fictional businesses and the passwords are deliberately public.

## Architecture in one paragraph

One Node 22 process (TypeScript run directly, one dependency: `postgres`)
serves every business. The tenant is resolved from the Host header
(`tenant_domains`, 30 s per-process cache). One shared Postgres database;
every table carries `tenant_id` with composite foreign keys so rows cannot
point across businesses. A business is described by a client file
(`clients/<slug>.json`) and created or updated with `npm run tenant:apply`.
Public site content is versioned (draft → preview → publish → restore).
Uploaded images live under `t/<tenant_id>/` in S3, served through CloudFront.
Background jobs (reminders, payment expiry) run from an EventBridge rule
calling `POST /internal/cron` every minute.

```
Browser ──HTTPS──> ALB (ACM *.reservo.joaoxu.dev) ──> ECS Fargate task (public subnet, SG: ALB only)
                                                        ├─> RDS Postgres 16 (private subnets)
                                                        ├─> S3 media bucket (gateway endpoint, task role)
                                                        └─> ifthenpay / Brevo / Meta (not live yet)
Browser ──HTTPS──> CloudFront media.reservo.joaoxu.dev ──OAC──> S3 media bucket
EventBridge (every minute) ──HTTPS──> /internal/cron
CloudWatch alarms (6) ──> SNS ──> founder's email
```

## Implemented

### Booking product (before the platform phases)
- Public site, booking flow with slot search; a Postgres exclusion constraint
  makes double bookings impossible; "no preference" staff bookings retry on
  deadlock (40P01).
- ifthenpay MB WAY / Multibanco / card client and webhooks, idempotent
  `settlePayment`; mock gateway for demos.
- Owner dashboard: agenda, manual bookings, days off, cash payments,
  services, staff, settings.
- Reminder and payment-expiry jobs; email (Brevo), SMS and WhatsApp (Meta)
  providers, all defaulting to `log`.
- RGPD export and erasure, customer data retention.
- Payment keys encrypted with `DATA_ENCRYPTION_KEY`.

### Platform phase 1: many businesses (27 Oct)
- Business types: massage, salon, barber, beauty, with per-type wording
  (`tb()` in `i18n.ts`, `staffWord()` in the dashboard).
- Client files plus `tenant:apply`: idempotent, `--dry-run`,
  `--overwrite-site`; errors name the path in the JSON.
- Versioned sites: draft, preview (`?preview=1`, signed-in only, `noindex`),
  publish, discard, restore; section order and visibility.

### Platform phase 2: design (28 Oct)
- Templates: Classic and Studio. Two font pairings, six palettes plus custom
  colours, all checked for 4.5:1 contrast.
- Gallery, testimonials and FAQ sections with dashboard editors.
- English service categories (`category_en`).
- Navalha barbershop demo.

### Platform phase 3: photos (28 Oct)
- `media` table and Fotos page in the dashboard.
- Browser re-encodes uploads (max 2000px, drops GPS). The server re-checks
  the type by content, measures the image and strips metadata.
- Per-business limits: 5 MB per file, 200 files.
- Logo, cover, gallery and staff photos are picked from the business's own
  library; staff photos have a composite FK.
- Client files upload the photos stored next to them, using content-hash
  names.
- S3 calls signed by hand (`src/lib/sigv4.ts`), credentials from the ECS task
  role. CSP `img-src` allows only `'self' data:` and the media origin.
- Verified in production: uploading, serving through CloudFront (cache hit
  on the second request), GPS stripping, and deleting. Direct S3 access
  returns 403.

### Infrastructure (`deploy/aws/`)
- ECS Fargate ARM64 (1 task, 0.25 vCPU / 512 MB) with a circuit breaker.
- ALB with HTTPS and an HTTP→HTTPS redirect.
- RDS PG16 `db.t4g.micro`: deletion protection, 7-day backups.
- Secrets Manager (3 secrets); ECR with immutable SHA tags.
- Route 53 zone `joaoxu.dev`; S3 media bucket with versioning and 30-day
  expiry of old versions; CloudFront with OAC.
- 6 CloudWatch alarms to SNS email.
- Terraform state in S3 with a native lockfile.
- Estimated cost: about $56/month plus $0.50 for Route 53. CloudFront and S3
  stay within the free tier at this scale.

## Unfinished

| Item | State |
|---|---|
| Phase 4: custom domains per business | Designed (option A: one ACM cert per domain on the ALB, DNS in Route 53), not started. Waiting on the founder's choice: build now with a second test domain, or wait for the first client's domain. |
| Phase 5: hardening | Not started: Postgres RLS, ignore client `X-Forwarded-Host`, wider cross-tenant/caching tests. |
| Real payments | ifthenpay never called for real; Multibanco sandbox path is a guess. |
| Real messages | Brevo, SMS and WhatsApp code untested against the real APIs; templates not approved in Meta. |
| Automated deploy | `make release` is manual; `ci.yml` builds and pushes to GHCR, which AWS doesn't use. GitHub Actions → AWS via OIDC not done. |
| Restore test | RDS restore never tested. |
| Thumbnails | Images served at upload size (≤2000px); needs `sharp` (new dependency, ask first) or an image CDN. |
| Product name and domain | Undecided; everything runs on `reservo.joaoxu.dev`. |

## Known issues and technical debt

- **`X-Forwarded-Host` is trusted** whenever `TRUST_PROXY_HOPS > 0`
  (`src/http/core.ts:107`). The ALB passes a client-sent value through, so a
  request can choose its tenant by header. This is harmless today because
  nothing caches by host, but it must be fixed before a cache sits in front
  (phase 5).
- **No row-level security yet.** Isolation relies on every query filtering by
  `tenant_id` and on the composite FKs.
- **Tenant cache is per process (30 s).** With more than one task, settings
  changes take up to 30 s to appear everywhere.
- **DB TLS is `sslmode=require`**, so the CA is not verified.
- **Single AZ, single task.** A task restart or an RDS maintenance window
  means a short outage. Multi-AZ costs about €14/month more.
- **Refunds are manual** in the ifthenpay back office, and the
  cancelled-booking wording doesn't say so yet.
- **Images are not resized server-side.** The browser does it, but client
  files and non-browser uploads are only capped at 5 MB.
- **GCP Terraform has drifted** (`deploy/gcp/`): it has no media storage
  settings, so production there would default to `MEDIA_STORAGE=s3` with no
  bucket. It is either maintained or deleted (open decision).

## Documentation drift (docs only, not fixed yet)

- `.env.example` points to `docs/OPERATIONS.md`, which doesn't exist (the
  key-rotation notes are in `docs/DEPLOY.md` › Operating it), and it doesn't
  list the `MEDIA_*` variables.
- `docs/DEPLOY.md` still calls Google Cloud "recommended to start". AWS was
  chosen.
- `docs/CONTINUE_IN_VSCODE.md` is the original hand-off note (region
  `eu-south-2`, "next task: deploy to AWS"). It is historical.
- `docs/ONBOARDING.md` › Domain describes the manual SQL and CNAME approach.
  Phase 4 replaces it.
- `deploy/aws/README.md` cost table doesn't list Route 53 ($0.50) or
  CloudFront/S3 (free tier).

## Not recoverable from the code or the conversation summary

Each of these needs the founder to confirm.

1. **SNS alarm subscription**: was the confirmation email clicked? The alarms
   show OK, but that doesn't prove anyone gets the emails.
2. **`DATA_ENCRYPTION_KEY` backup**: is it in a password manager outside AWS?
3. **CI on GitHub**: did the pushes of `ed76c0d` / `64c7b16` pass? `gh` isn't
   installed here, so this wasn't checked.
4. **Backup of local-only files**: `deploy/aws/terraform.tfvars`,
   `deploy/aws/bootstrap/terraform.tfstate`, `.env`.
5. **Phase 4 approach**: build now with a second test domain, or wait for a
   real client domain. This was asked and not answered.
6. **External accounts**: the status of the ifthenpay contract, Brevo, the
   Meta Business / WhatsApp templates, and SMS sender registration.
7. **Business plan and pitch deck** (Claude Docs "Reservo Business Plan" /
   "Reservo Pitch"): their contents aren't in the repo. Pricing and the
   founding-partner terms in CLAUDE.md may be out of date.
8. **`deploy/gcp/`**: keep or delete?
9. **Data processing agreement for studios**: does a template exist yet? It
   should list CloudFront edges (EU + North America) as a sub-processor
   location.
10. **Terraform credentials**: last session used a `credential_process`
    config in a temporary scratchpad folder, which is gone. Recreate it as in
    `deploy/aws/README.md` › Credentials.
