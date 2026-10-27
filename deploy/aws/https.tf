# --- HTTPS (off until there is a domain) ----------------------------------------------
# Two steps once the domain is bought:
#
#   1. Set domain_name = "example.pt" and apply. This requests an ACM
#      certificate for example.pt + *.example.pt.
#      - With route53_zone set (e.g. "example.pt"), Terraform creates the
#        hosted zone, the validation CNAMEs and *.example.pt -> ALB. Point the
#        registrar at the `name_servers` output.
#      - Without it, add the CNAMEs from `acm_validation_records` at your DNS
#        provider and point app.example.pt and *.example.pt at the ALB.
#   2. Once the certificate is issued, set https_enabled = true and apply.
#      That adds the :443 listener, turns :80 into a redirect, sets
#      PUBLIC_BASE_URL=https://app.example.pt and PLATFORM_DOMAIN=example.pt,
#      and moves background jobs from the web task to an EventBridge rule
#      calling POST /internal/cron every minute.
#
# Then re-run the demo seed so mare.example.pt becomes the studio's domain.
# Studio custom domains: add each certificate with aws_lb_listener_certificate.

variable "domain_name" {
  type        = string
  default     = ""
  description = "Platform domain (studios get <slug>.<domain>). Empty = HTTP only on the ALB DNS name"
}
variable "route53_zone" {
  type        = string
  default     = ""
  description = "Route 53 hosted zone to create for DNS (domain_name or a parent of it). Empty = DNS managed elsewhere"
}
variable "https_enabled" {
  type        = bool
  default     = false
  description = "Turn on once the ACM certificate's DNS validation records exist"
}

locals {
  https           = var.domain_name != "" && var.https_enabled
  route53         = var.domain_name != "" && var.route53_zone != ""
  platform_domain = local.https ? var.domain_name : aws_lb.main.dns_name
  public_base_url = local.https ? "https://app.${var.domain_name}" : "http://${aws_lb.main.dns_name}"
  demo_url        = local.https ? "https://mare.${var.domain_name}" : local.public_base_url
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
  count                   = local.https ? 1 : 0
  certificate_arn         = aws_acm_certificate.main[0].arn
  validation_record_fqdns = local.route53 ? aws_route53_record.acm[*].fqdn : null
}

# --- DNS in Route 53 (optional) ----------------------------------------------------------
# Recreating the zone changes its name servers and breaks the delegation at
# the registrar, hence prevent_destroy. ~$0.50/month.
resource "aws_route53_zone" "main" {
  count = local.route53 ? 1 : 0
  name  = var.route53_zone
  lifecycle { prevent_destroy = true }
}

# ACM gives the apex and the wildcard the same validation CNAME, so one record
# covers both. (count, not for_each: the options are unknown until the
# certificate exists.)
locals {
  acm_validation = local.route53 ? one([for o in aws_acm_certificate.main[0].domain_validation_options : o if o.domain_name == var.domain_name]) : null
}

resource "aws_route53_record" "acm" {
  count   = local.route53 ? 1 : 0
  zone_id = aws_route53_zone.main[0].zone_id
  name    = local.acm_validation.resource_record_name
  type    = local.acm_validation.resource_record_type
  records = [local.acm_validation.resource_record_value]
  ttl     = 300
}

# app.<domain> (platform) and <slug>.<domain> (studios) -> ALB.
resource "aws_route53_record" "wildcard" {
  count   = local.route53 ? 1 : 0
  zone_id = aws_route53_zone.main[0].zone_id
  name    = "*.${var.domain_name}"
  type    = "A"
  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = false
  }
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
