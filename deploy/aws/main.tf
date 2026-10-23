# Reservo on AWS: ECS Fargate (app) behind an ALB + RDS Postgres 16 +
# Secrets Manager + CloudWatch alarms. Region eu-west-1 (Ireland).
#
# No NAT gateway: tasks run in public subnets with a public IP, and their
# security group only accepts traffic from the ALB. RDS sits in private
# subnets with no route to the internet.
#
# Until a domain exists the ALB serves plain HTTP on its own DNS name and
# background jobs run inside the web task (INLINE_WORKER=true), because
# EventBridge API destinations only call HTTPS endpoints. Setting
# domain_name / https_enabled (see https.tf) switches on HTTPS, the
# HTTP->HTTPS redirect and the every-minute EventBridge cron.
#
# Deploy steps: see README.md and the Makefile.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # Bucket created by bootstrap/. S3-native locking (use_lockfile).
  backend "s3" {
    bucket       = "reservo-tfstate-847047140632"
    key          = "reservo/prod.tfstate"
    region       = "eu-west-1"
    encrypt      = true
    use_lockfile = true
  }
}

variable "region" {
  type    = string
  default = "eu-west-1"
}
variable "name" {
  type    = string
  default = "reservo"
}
variable "image_tag" {
  type        = string
  description = "Tag of the app image in ECR (the Makefile passes the git short SHA)"
}
variable "alarm_email" {
  type        = string
  description = "Where CloudWatch alarms are emailed (confirm the SNS subscription email once)"
}
variable "desired_count" {
  type    = number
  default = 1
}
variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

provider "aws" {
  region = var.region
  default_tags {
    tags = { Project = var.name, ManagedBy = "terraform" }
  }
}

data "aws_caller_identity" "me" {}
data "aws_availability_zones" "available" { state = "available" }

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}
