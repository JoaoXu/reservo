# Next steps

Prioritised 28 Oct 2026. Status and known issues are in
[PROJECT_STATUS.md](PROJECT_STATUS.md). Items marked **founder** need the
founder (an account, a decision or a click). The rest is code or Terraform
work Claude can do once asked. Every `terraform apply` still waits for the
founder's OK.

## P0: quick checks (minutes, founder)

1. **Confirm the SNS alarm subscription email** was clicked. Otherwise
   alarms go nowhere.
2. **Back up `DATA_ENCRYPTION_KEY`** to a password manager (command in
   `deploy/aws/README.md`). Losing it means every studio re-enters its
   payment keys.
3. **Back up the local-only files**: `deploy/aws/terraform.tfvars`,
   `deploy/aws/bootstrap/terraform.tfstate`, `.env`.
4. **Check GitHub Actions** is green for the latest push (or install `gh` so
   Claude can check).

## P1: before the first paying business

Without these, a real studio can't safely go live.

1. **ifthenpay sandbox test, then a €1 live test** (**founder**: contract and
   keys). Confirm the Multibanco sandbox path with ifthenpay support. Run
   MB WAY, Multibanco and card end to end, including the callbacks and the
   anti-phishing key.
2. **Real messages** (**founder**: accounts).
   - Brevo with a sending domain; SMS sender name.
   - Meta WhatsApp templates `booking_confirmed` and `booking_reminder`
     (text in `ONBOARDING.md`).
   - Then switch the providers from `log` in `ecs.tf` and test the
     reminders. Reminders are a core selling point.
3. **RDS restore test**: restore a snapshot to a temporary instance, check
   the data, and delete only that temporary instance with the founder's
   explicit OK.
4. **Ignore client-sent `X-Forwarded-Host`** (`src/http/core.ts:107`). This
   is the cheap half of phase 5. The ALB already sends the real `Host`.
   Small change plus a test.
5. **Refund wording** on cancelled paid bookings: say that refunds are done
   by the studio.
6. **Data processing agreement template** for studios (**founder**). List the
   sub-processors: AWS eu-west-1, CloudFront edges in the EU and North
   America, ifthenpay, Brevo, Meta.

## P2: Phase 4, custom domains

**Founder decision first:** build now with a second test domain, or wait for
the first client's domain. The build is the same either way.

- Terraform: a domains map with a Route 53 zone, an ACM certificate per
  domain, apex and `www` aliases to the ALB, and a listener certificate.
  Each certificate on the ALB is free; a hosted zone is $0.50/month per
  domain.
- `tenant_domains` status `pending` → `active`; only active domains resolve.
- A `tenant:domain` command, used only by the platform admin.
- Redirect to the primary domain (the platform subdomain stays as preview
  and fallback).
- Rewrite `docs/ONBOARDING.md` › Domain.
- Limit: an ALB takes 25 certificates by default (a quota increase is
  possible). Beyond that, CloudFront or a SAN strategy is needed. Not
  urgent for now.

## P3: Phase 5, hardening

- Postgres row-level security as a second wall behind the `tenant_id`
  filters (app role without `BYPASSRLS`, `set_config('app.tenant_id')` per
  request or transaction).
- Wider cross-tenant tests (every dashboard route with another tenant's ids)
  and caching tests.
- `sslmode=verify-full` with the RDS CA bundle in the image.

## P4: delivery and operations

- **GitHub Actions deploy to AWS with OIDC**: no long-lived keys. Push to
  ECR and run the same order as `make release`, keeping a manual approval
  before apply. Drop the GHCR push or keep it as a mirror.
- **Decide on `deploy/gcp/`** (**founder**): delete it, or add media storage
  so it works again.
- **Fix the docs drift** listed in PROJECT_STATUS.md: `.env.example`
  (`OPERATIONS.md`, `MEDIA_*`), the GCP recommendation in `DEPLOY.md`,
  `CONTINUE_IN_VSCODE.md`, and the cost table.

## Later (when there is demand)

- Thumbnails and responsive images. Needs `sharp`, a new dependency (ask
  first), or an image CDN.
- Multi-AZ RDS (about €14/month) and a second task (about €10/month) once
  paying studios depend on uptime.
- RDS Proxy or PgBouncer as tasks × `DB_POOL_MAX` approaches
  `max_connections`.
- Restaurants (a different booking model: tables and covers), explicitly out
  of scope for now.
- Product name, domain and pricing (**founder**). Switching from
  `reservo.joaoxu.dev` means changing `domain_name` / `route53_zone`,
  applying, delegating, then re-seeding.
