# Reservo on Google Cloud: Cloud Run (app) + Cloud SQL Postgres + Secret
# Manager + Cloud Scheduler for background jobs. Region europe-west1
# (Belgium) keeps data in the EU; europe-southwest1 (Madrid) is closer.
#
#   terraform init && terraform apply -var project_id=... -var image=...
#
# Rough cost at launch: Cloud SQL db-f1-micro ~€10/month, Cloud Run near
# zero at low traffic (min 1 instance ~€8/month to avoid cold starts).

terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "europe-west1"
}
variable "image" {
  type        = string
  description = "Container image, e.g. europe-west1-docker.pkg.dev/PROJECT/reservo/app:SHA"
}
variable "platform_domain" {
  type        = string
  default     = "reservo.pt"
  description = "Studios get <slug>.<platform_domain>"
}
variable "public_base_url" {
  type    = string
  default = "https://app.reservo.pt"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

resource "google_project_service" "apis" {
  for_each           = toset(["run.googleapis.com", "sqladmin.googleapis.com", "secretmanager.googleapis.com", "cloudscheduler.googleapis.com", "artifactregistry.googleapis.com"])
  service            = each.key
  disable_on_destroy = false
}

# --- Database -----------------------------------------------------------------
resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "pg" {
  name             = "reservo-pg"
  database_version = "POSTGRES_16"
  region           = var.region
  settings {
    tier              = "db-f1-micro" # move to db-custom-1-3840 when you outgrow it
    availability_type = "ZONAL"       # REGIONAL for high availability later
    disk_autoresize   = true
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "03:00"
    }
    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }
    database_flags {
      name  = "max_connections"
      value = "100"
    }
  }
  deletion_protection = true
  depends_on          = [google_project_service.apis]
}

resource "google_sql_database" "app" {
  name     = "reservo"
  instance = google_sql_database_instance.pg.name
}

resource "google_sql_user" "app" {
  name     = "reservo"
  instance = google_sql_database_instance.pg.name
  password = random_password.db.result
}

# --- Secrets --------------------------------------------------------------------
resource "random_bytes" "data_key" { length = 32 }
resource "random_password" "cron" {
  length  = 48
  special = false
}

locals {
  # Cloud Run connects to Cloud SQL through the built-in unix socket; the
  # driver reads the socket directory from PGHOST (set below).
  database_url = "postgres://reservo:${random_password.db.result}@localhost/reservo"
  pghost       = "/cloudsql/${google_sql_database_instance.pg.connection_name}"
  secrets = {
    DATABASE_URL        = local.database_url
    DATA_ENCRYPTION_KEY = random_bytes.data_key.base64
    CRON_SECRET         = random_password.cron.result
  }
}

resource "google_secret_manager_secret" "s" {
  for_each  = local.secrets
  secret_id = "reservo-${lower(replace(each.key, "_", "-"))}"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "s" {
  for_each    = local.secrets
  secret      = google_secret_manager_secret.s[each.key].id
  secret_data = each.value
}

# Add BREVO_API_KEY / META_WHATSAPP_TOKEN as secrets the same way when you
# switch messages on.

# --- Service account --------------------------------------------------------------
resource "google_service_account" "app" {
  account_id   = "reservo-app"
  display_name = "Reservo app"
}

resource "google_project_iam_member" "sql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.app.email}"
}

resource "google_secret_manager_secret_iam_member" "read" {
  for_each  = google_secret_manager_secret.s
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
}

locals {
  plain_env = {
    NODE_ENV          = "production"
    PGHOST            = local.pghost
    PUBLIC_BASE_URL   = var.public_base_url
    PLATFORM_DOMAIN   = var.platform_domain
    TRUST_PROXY_HOPS  = "1"
    INLINE_WORKER     = "false"
    DB_POOL_MAX       = "5"
    EMAIL_PROVIDER    = "log"
    SMS_PROVIDER      = "log"
    WHATSAPP_PROVIDER = "log"
  }
}

# --- App ---------------------------------------------------------------------------
resource "google_cloud_run_v2_service" "app" {
  name     = "reservo"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.app.email
    scaling {
      min_instance_count = 1
      max_instance_count = 10 # 10 x DB_POOL_MAX 5 = 50 connections, under max_connections
    }
    max_instance_request_concurrency = 80
    volumes {
      name = "cloudsql"
      cloud_sql_instance { instances = [google_sql_database_instance.pg.connection_name] }
    }
    containers {
      image = var.image
      ports { container_port = 8080 }
      resources {
        limits            = { cpu = "1", memory = "512Mi" }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      dynamic "env" {
        for_each = local.plain_env
        content {
          name  = env.key
          value = env.value
        }
      }
      dynamic "env" {
        for_each = google_secret_manager_secret.s
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value.secret_id
              version = "latest"
            }
          }
        }
      }
      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }
      startup_probe {
        http_get { path = "/healthz" }
      }
      liveness_probe {
        http_get { path = "/healthz" }
        period_seconds = 30
      }
    }
  }
  depends_on = [google_secret_manager_secret_version.s, google_project_iam_member.sql]
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.app.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Migrations run as a job before each deploy:
#   gcloud run jobs execute reservo-migrate --region europe-west1 --wait
resource "google_cloud_run_v2_job" "migrate" {
  name     = "reservo-migrate"
  location = var.region
  template {
    template {
      service_account = google_service_account.app.email
      max_retries     = 1
      volumes {
        name = "cloudsql"
        cloud_sql_instance { instances = [google_sql_database_instance.pg.connection_name] }
      }
      containers {
        image   = var.image
        command = ["node", "scripts/migrate.ts"]
        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.s["DATABASE_URL"].secret_id
              version = "latest"
            }
          }
        }
        env {
          name  = "NODE_ENV"
          value = "production"
        }
        env {
          name  = "PGHOST"
          value = local.pghost
        }
        env {
          name = "DATA_ENCRYPTION_KEY"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.s["DATA_ENCRYPTION_KEY"].secret_id
              version = "latest"
            }
          }
        }
        env {
          name = "CRON_SECRET"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.s["CRON_SECRET"].secret_id
              version = "latest"
            }
          }
        }
        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }
  }
}

# Background jobs (expire unpaid holds, reminders, MB WAY reconcile) every minute.
resource "google_cloud_scheduler_job" "cron" {
  name      = "reservo-cron"
  region    = var.region
  schedule  = "* * * * *"
  time_zone = "Europe/Lisbon"
  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.app.uri}/internal/cron"
    headers     = { Authorization = "Bearer ${random_password.cron.result}" }
  }
  depends_on = [google_project_service.apis]
}

output "url" { value = google_cloud_run_v2_service.app.uri }
output "sql_connection_name" { value = google_sql_database_instance.pg.connection_name }
