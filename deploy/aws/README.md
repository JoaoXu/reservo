# Reservo on AWS

ECS Fargate behind an Application Load Balancer, RDS PostgreSQL 16, Secrets
Manager, CloudWatch alarms to email. Region `eu-west-1`. Terraform state in S3
with native locking.

```
internet ─▶ ALB :80 (:443 later) ─▶ ECS task :8080 (public subnet, public IP,
                                     SG: only from ALB) ─▶ RDS :5432 (private subnet)
```

No NAT gateway (saves ~€35/month): tasks sit in public subnets with a public
IP so they can reach ECR, Secrets Manager, CloudWatch and ifthenpay, and their
security group accepts connections only from the ALB.

## Files

| File | What |
|---|---|
| `bootstrap/` | One-time: S3 bucket for Terraform state |
| `main.tf` | Providers, backend, variables |
| `network.tf` | VPC, subnets, security groups |
| `database.tf` | RDS Postgres 16 (encrypted, private, 7-day backups, deletion protection) |
| `secrets.tf` | `DATABASE_URL`, `DATA_ENCRYPTION_KEY`, `CRON_SECRET` in Secrets Manager |
| `ecs.tf` | ECR, log group, IAM, task definitions (app + one-off migrate), service |
| `alb.tf` | Load balancer, target group (`/healthz`), HTTP listener |
| `https.tf` | **Off for now.** ACM certificate, HTTPS listener, EventBridge cron |
| `monitoring.tf` | SNS email + alarms: 5xx, no healthy task, error logs, RDS CPU/storage |
| `run-task.sh` | Runs a one-off task (migrations, seed) and waits for the exit code |

## Credentials

Terraform 1.10's S3 backend can't read an `aws login` session (the AWS
provider can). Either export the session's short-lived credentials
(`eval "$(aws configure export-credentials --format env)"`, they expire in
~15 min, too short for an RDS apply) or point Terraform at a config whose
profile refreshes them:

```ini
# ~/.aws/terraform.config, then: export AWS_CONFIG_FILE=~/.aws/terraform.config
[default]
region = eu-west-1
credential_process = env AWS_CONFIG_FILE=/Users/YOU/.aws/config aws configure export-credentials --format process
```

Use AWS CLI v2 (`aws login` needs it); `AWS=/opt/homebrew/bin/aws make ...`
if an older `aws` comes first on your PATH.

## First deploy

```bash
aws login                                  # or: export AWS_PROFILE=...
cd deploy/aws/bootstrap && terraform init && terraform apply && cd ..
cp terraform.tfvars.example terraform.tfvars   # set alarm_email
make init
terraform apply -var image_tag=$(git rev-parse --short HEAD) \
  -target=aws_ecr_repository.app -target=aws_ecr_lifecycle_policy.app
make push                                  # build linux/arm64 image, push to ECR
make plan && make apply                    # everything else (RDS takes ~10 min)
make migrate
make seed                                  # demo studio on the ALB hostname
make smoke
```

Confirm the SNS subscription email, or alarms go nowhere.

**Back up the data encryption key** outside AWS (password manager), once:

```bash
aws secretsmanager get-secret-value --secret-id reservo/DATA_ENCRYPTION_KEY \
  --query SecretString --output text
```

## Each release

```bash
git commit ...           # the image tag is the git short SHA
make release             # push, migrate (new image), plan + apply, wait, smoke test
```

`release` updates the migrate task definition first and runs it, so the schema
is migrated before the service runs new code. Each `terraform apply` still asks
for confirmation. ECS rolls out with the circuit breaker on: if the new task
never passes `/healthz`, it rolls back.

## Adding HTTPS when the domain exists

See the comment at the top of `https.tf`: set `domain_name`, apply, add the
ACM validation CNAMEs, point `app.` and `*.` at the ALB, then set
`https_enabled = true` and apply. That also moves background jobs from the web
task (`INLINE_WORKER=true`) to an EventBridge rule calling `/internal/cron`
every minute (API destinations require HTTPS). Re-run `make seed` afterwards.

## Known limits

- Without HTTPS (no `domain_name`), the demo's simulated card payment and the
  "manage booking" links build absolute `https://mare.<PLATFORM_DOMAIN>` URLs,
  which don't resolve on the ALB hostname.
- DB TLS uses `sslmode=require` (encrypted, CA not verified). To verify, ship
  the RDS CA bundle in the image and use `sslmode=verify-full`.

## Rough monthly cost (eu-west-1, on-demand, before free tier)

| Item | USD |
|---|---|
| ALB (hours + minimal LCU) | ~19 |
| RDS db.t4g.micro + 20 GB gp3 | ~16 |
| Public IPv4: 2 ALB + 1 task | ~11 |
| Fargate ARM 0.25 vCPU / 0.5 GB, 1 task | ~7 |
| Secrets Manager (3), alarms (6), logs, ECR, S3 | ~3 |
| **Total** | **~56 (≈ €52)** |

Multi-AZ RDS adds ~€14; a second always-on task ~€10 (6.5 compute + 3.4 IP).

## Safety

`terraform destroy` is blocked in `.claude/settings.json`; RDS has deletion
protection and `prevent_destroy`; the state bucket and data key have
`prevent_destroy` too.
