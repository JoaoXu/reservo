# Deployment

The same image runs three ways: the web app (`node src/server.ts`), the
worker (`node src/worker.ts`) and migrations (`node scripts/migrate.ts`).

## Required configuration

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres 14+ connection string. For Cloud SQL sockets, also set `PGHOST=/cloudsql/<instance>`. |
| `DATA_ENCRYPTION_KEY` | 32 random bytes, base64. Encrypts payment keys. **Back it up**: losing it means every studio re-enters its keys. |
| `CRON_SECRET` | Long random string for `POST /internal/cron`. |
| `PUBLIC_BASE_URL` | Where ifthenpay callbacks land, e.g. `https://app.reservo.pt`. |
| `PLATFORM_DOMAIN` | Studios get `<slug>.<PLATFORM_DOMAIN>`, e.g. `reservo.pt`. |
| `TRUST_PROXY_HOPS` | `1` behind Cloud Run or an ALB. |
| `INLINE_WORKER` | `false` when a scheduler or the worker runs jobs. |

Messages: `EMAIL_PROVIDER=brevo`, `SMS_PROVIDER=brevo`, `BREVO_API_KEY`,
`EMAIL_FROM` (a domain verified in Brevo); `WHATSAPP_PROVIDER=meta`,
`META_WHATSAPP_TOKEN`, `META_WHATSAPP_PHONE_ID` and the approved template names.

## Google Cloud (recommended to start: cheapest at low traffic)

`deploy/gcp/main.tf` creates Cloud Run, Cloud SQL (Postgres 16, backups and
point-in-time recovery on), Secret Manager entries, a migration job and a
Cloud Scheduler job that runs background work every minute.

```bash
gcloud artifacts repositories create reservo --repository-format=docker --location=europe-west1
docker build -t europe-west1-docker.pkg.dev/$PROJECT/reservo/app:v1 .
docker push europe-west1-docker.pkg.dev/$PROJECT/reservo/app:v1
cd deploy/gcp
terraform init
terraform apply -var project_id=$PROJECT -var image=europe-west1-docker.pkg.dev/$PROJECT/reservo/app:v1
gcloud run jobs execute reservo-migrate --region europe-west1 --wait
```

Domains: map `app.reservo.pt` and the wildcard `*.reservo.pt` to the service
with a global external Application Load Balancer + serverless NEG and a
Certificate Manager wildcard certificate (DNS authorisation). For studio
custom domains, add each to the certificate map (or use Cloud Run domain
mappings for a handful).

Each deploy: build and push the image, `gcloud run jobs update reservo-migrate --image …`,
execute it, then `gcloud run deploy reservo --image …`. Migrations are
additive, so the old version keeps working while the new one rolls out.

## AWS

Equivalent setup:

- **App:** ECS Fargate service (0.25 vCPU / 512 MB is plenty at first) behind
  an Application Load Balancer with an ACM wildcard certificate for
  `*.reservo.pt`; add each studio's custom domain as an extra certificate on
  the HTTPS listener. Health check path `/healthz`. App Runner also works and
  is simpler, at the cost of custom-domain limits.
- **Database:** RDS for PostgreSQL 16, `db.t4g.micro`, automated backups 7+
  days, encryption at rest, in private subnets. Allow 5432 only from the
  service's security group.
- **Secrets:** Secrets Manager, injected as ECS task secrets.
- **Jobs:** an EventBridge Scheduler rule every minute calling
  `POST https://app.reservo.pt/internal/cron` (API destination with the bearer
  token), or run a second ECS service with `node src/worker.ts`.
- **Migrations:** a one-off ECS task with command `node scripts/migrate.ts`
  before updating the service.
- **Logs:** stdout JSON goes to CloudWatch Logs; create a metric filter on
  `"level":"error"` and an alarm.

## Operating it

- **Backups:** test a restore once before your first paying customer.
- **Alerts worth having:** 5xx rate, `/readyz` failures, `payment start failed`
  and `callback with bad anti-phishing key` log lines, Cloud SQL CPU > 70%.
- **Rotating `DATA_ENCRYPTION_KEY`:** decrypt all `tenants.payment_secrets`
  with the old key and re-encrypt with the new one in a one-off script, then
  swap the secret.
- **Uptime:** studios lose bookings if the site is down. Keep at least one
  warm instance (`min_instance_count = 1`).
