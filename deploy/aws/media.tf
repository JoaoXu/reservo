# --- Media: uploaded images --------------------------------------------------------------
# Private S3 bucket, served only through CloudFront (Origin Access Control) at
# media.<domain>. The app writes with the ECS task role, limited to put/delete
# under t/ (one prefix per business). Object names are uuids or content
# hashes, so they never change and are cached for a year.
#
# Cost at this scale: CloudFront's always-free tier (1 TB, 10M requests a
# month) covers it; S3 storage is cents a month.

locals {
  media_alias    = local.https && local.route53
  media_host     = "media.${var.domain_name}"
  media_base_url = local.media_alias ? "https://${local.media_host}" : "https://${aws_cloudfront_distribution.media.domain_name}"
}

resource "aws_s3_bucket" "media" {
  bucket = "${var.name}-media-${data.aws_caller_identity.me.account_id}"
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

# Versioning undoes an accidental delete; old versions go after 30 days.
resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    id     = "expire-deleted"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 30 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
  depends_on = [aws_s3_bucket_versioning.media]
}

resource "aws_s3_bucket_policy" "media" {
  bucket = aws_s3_bucket.media.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "CloudFrontReads"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.media.arn}/*"
        Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.media.arn } }
      },
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource  = [aws_s3_bucket.media.arn, "${aws_s3_bucket.media.arn}/*"]
        Condition = { Bool = { "aws:SecureTransport" = "false" } }
      },
    ]
  })
  depends_on = [aws_s3_bucket_public_access_block.media]
}

# Tasks reach S3 over this free gateway endpoint instead of the public internet.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id, aws_route_table.private.id]
  tags              = { Name = "${var.name}-s3" }
}

# --- CloudFront ---------------------------------------------------------------------------
data "aws_cloudfront_cache_policy" "optimized" { name = "Managed-CachingOptimized" }
data "aws_cloudfront_response_headers_policy" "security" { name = "Managed-SecurityHeadersPolicy" }

resource "aws_cloudfront_origin_access_control" "media" {
  name                              = "${var.name}-media"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CloudFront only accepts certificates from us-east-1.
resource "aws_acm_certificate" "media" {
  count             = local.media_alias ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = local.media_host
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "media_validation" {
  count   = local.media_alias ? 1 : 0
  zone_id = aws_route53_zone.main[0].zone_id
  name    = one(aws_acm_certificate.media[0].domain_validation_options).resource_record_name
  type    = one(aws_acm_certificate.media[0].domain_validation_options).resource_record_type
  records = [one(aws_acm_certificate.media[0].domain_validation_options).resource_record_value]
  ttl     = 300
}

resource "aws_acm_certificate_validation" "media" {
  count                   = local.media_alias ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.media[0].arn
  validation_record_fqdns = [aws_route53_record.media_validation[0].fqdn]
}

resource "aws_cloudfront_distribution" "media" {
  enabled         = true
  comment         = "${var.name} uploaded images"
  is_ipv6_enabled = true
  http_version    = "http2and3"
  price_class     = "PriceClass_100" # Europe and North America edges
  aliases         = local.media_alias ? [local.media_host] : []

  origin {
    origin_id                = "s3-media"
    domain_name              = aws_s3_bucket.media.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.media.id
  }

  default_cache_behavior {
    target_origin_id           = "s3-media"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = !local.media_alias
    acm_certificate_arn            = local.media_alias ? aws_acm_certificate_validation.media[0].certificate_arn : null
    ssl_support_method             = local.media_alias ? "sni-only" : null
    minimum_protocol_version       = local.media_alias ? "TLSv1.2_2021" : null
  }
}

resource "aws_route53_record" "media" {
  for_each = local.media_alias ? toset(["A", "AAAA"]) : toset([])
  zone_id  = aws_route53_zone.main[0].zone_id
  name     = local.media_host
  type     = each.key
  alias {
    name                   = aws_cloudfront_distribution.media.domain_name
    zone_id                = aws_cloudfront_distribution.media.hosted_zone_id
    evaluate_target_health = false
  }
}

# --- Task role: what the app itself may do in AWS (only this) --------------------------------
resource "aws_iam_role" "task" {
  name = "${var.name}-ecs-task"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy" "task_media" {
  name = "media-write"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["s3:PutObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.media.arn}/t/*" }]
  })
}
