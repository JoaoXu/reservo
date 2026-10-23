# --- HTTPS (off until there is a domain) ----------------------------------------------
# Two steps once the domain is bought:
#
#   1. Set domain_name = "example.pt" and apply. This requests an ACM
#      certificate for example.pt + *.example.pt; add the CNAMEs from the
#      `acm_validation_records` output at your DNS provider.
#   2. Point app.example.pt and *.example.pt (CNAME/ALIAS) at the ALB, set
#      https_enabled = true and apply. That adds the :443 listener, turns :80
#      into a redirect, sets PUBLIC_BASE_URL=https://app.example.pt and
#      PLATFORM_DOMAIN=example.pt, and moves background jobs from the web task
#      to an EventBridge rule calling POST /internal/cron every minute.
#
# Then re-run the demo seed so mare.example.pt becomes the studio's domain.
# Studio custom domains: add each certificate with aws_lb_listener_certificate.

variable "domain_name" {
  type        = string
  default     = ""
  description = "Platform domain (studios get <slug>.<domain>). Empty = HTTP only on the ALB DNS name"
}
variable "https_enabled" {
  type        = bool
  default     = false
  description = "Turn on once the ACM certificate's DNS validation records exist"
}

locals {
  https           = var.domain_name != "" && var.https_enabled
  platform_domain = local.https ? var.domain_name : aws_lb.main.dns_name
  public_base_url = local.https ? "https://app.${var.domain_name}" : "http://${aws_lb.main.dns_name}"
}

resource "aws_acm_certificate" "main" {
  count                     = var.domain_name != "" ? 1 : 0
  domain_name               = var.domain_name
  subject_alternative_names = ["*.${var.domain_name}"]
  validation_method         = "DNS"
  lifecycle { create_before_destroy = true }
}

# Waits until ACM sees the validation records.
resource "aws_acm_certificate_validation" "main" {
  count           = local.https ? 1 : 0
  certificate_arn = aws_acm_certificate.main[0].arn
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  count             = local.https ? 1 : 0
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from anywhere"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_lb_listener" "https" {
  count             = local.https ? 1 : 0
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.main[0].certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# --- Background jobs via EventBridge (needs HTTPS) -------------------------------------
# API destinations only call HTTPS endpoints, so until then the web task runs
# the jobs itself (INLINE_WORKER=true, guarded by Postgres advisory locks).
resource "aws_cloudwatch_event_connection" "cron" {
  count              = local.https ? 1 : 0
  name               = "${var.name}-cron"
  authorization_type = "API_KEY"
  auth_parameters {
    api_key {
      key   = "Authorization"
      value = "Bearer ${random_password.cron.result}"
    }
  }
}

resource "aws_cloudwatch_event_api_destination" "cron" {
  count                            = local.https ? 1 : 0
  name                             = "${var.name}-cron"
  connection_arn                   = aws_cloudwatch_event_connection.cron[0].arn
  invocation_endpoint              = "${local.public_base_url}/internal/cron"
  http_method                      = "POST"
  invocation_rate_limit_per_second = 1
}

resource "aws_cloudwatch_event_rule" "cron" {
  count               = local.https ? 1 : 0
  name                = "${var.name}-cron"
  description         = "Expire unpaid holds, reminders, MB WAY reconcile"
  schedule_expression = "rate(1 minute)"
}

resource "aws_iam_role" "cron" {
  count = local.https ? 1 : 0
  name  = "${var.name}-cron"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "events.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "cron" {
  count = local.https ? 1 : 0
  role  = aws_iam_role.cron[0].id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "events:InvokeApiDestination", Resource = aws_cloudwatch_event_api_destination.cron[0].arn }]
  })
}

resource "aws_cloudwatch_event_target" "cron" {
  count    = local.https ? 1 : 0
  rule     = aws_cloudwatch_event_rule.cron[0].name
  arn      = aws_cloudwatch_event_api_destination.cron[0].arn
  role_arn = aws_iam_role.cron[0].arn
  retry_policy {
    maximum_retry_attempts       = 0 # the next run is a minute away
    maximum_event_age_in_seconds = 60
  }
}
