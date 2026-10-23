# --- Secrets Manager -----------------------------------------------------------------
# Injected into the task definitions as ECS secrets. Values live in the
# (encrypted) S3 state too, so never share terraform.tfstate.
#
# DATA_ENCRYPTION_KEY: back it up outside AWS after the first apply (see
# README.md). Losing it means every studio re-enters its payment keys.
resource "random_bytes" "data_key" {
  length = 32
  lifecycle { prevent_destroy = true }
}

resource "random_password" "cron" {
  length  = 48
  special = false
}

locals {
  # RDS Postgres 16 enforces TLS; sslmode=require encrypts without verifying
  # the RDS CA (postgres.js sets rejectUnauthorized=false for "require").
  database_url = "postgres://reservo:${random_password.db.result}@${aws_db_instance.pg.address}:5432/reservo?sslmode=require"
  secrets = {
    DATABASE_URL        = local.database_url
    DATA_ENCRYPTION_KEY = random_bytes.data_key.base64
    CRON_SECRET         = random_password.cron.result
  }
}

resource "aws_secretsmanager_secret" "s" {
  for_each = local.secrets
  name     = "${var.name}/${each.key}"
}

resource "aws_secretsmanager_secret_version" "s" {
  for_each      = local.secrets
  secret_id     = aws_secretsmanager_secret.s[each.key].id
  secret_string = each.value
}

# Add BREVO_API_KEY / META_WHATSAPP_TOKEN as secrets the same way when you
# switch messages on.
