# --- ECR -----------------------------------------------------------------------------
resource "aws_ecr_repository" "app" {
  name                 = var.name
  image_tag_mutability = "IMMUTABLE" # tags are git SHAs
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 15 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 15 }
      action       = { type = "expire" }
    }]
  })
}

# --- Logs ----------------------------------------------------------------------------
resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.name}"
  retention_in_days = 30
}

# --- IAM: the execution role pulls the image, writes logs, reads the secrets ---------
resource "aws_iam_role" "execution" {
  name = "${var.name}-ecs-execution"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  name = "read-app-secrets"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "secretsmanager:GetSecretValue", Resource = [for s in aws_secretsmanager_secret.s : s.arn] }]
  })
}

# --- Task definitions ------------------------------------------------------------------
locals {
  image = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
  plain_env = {
    NODE_ENV          = "production"
    PUBLIC_BASE_URL   = local.public_base_url
    PLATFORM_DOMAIN   = local.platform_domain
    TRUST_PROXY_HOPS  = "1"
    INLINE_WORKER     = local.https ? "false" : "true"
    DB_POOL_MAX       = "5"
    EMAIL_PROVIDER    = "log"
    SMS_PROVIDER      = "log"
    WHATSAPP_PROVIDER = "log"
  }
  container_env     = [for k, v in local.plain_env : { name = k, value = v }]
  container_secrets = [for k, s in aws_secretsmanager_secret.s : { name = k, valueFrom = s.arn }]
}

resource "aws_ecs_cluster" "main" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "disabled" # ~€3/month extra when enabled
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  # Graviton: ~20% cheaper than x86, and matches images built on Apple silicon.
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name         = "app"
    image        = local.image
    essential    = true
    portMappings = [{ containerPort = 8080, protocol = "tcp" }]
    environment  = local.container_env
    secrets      = local.container_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "app"
      }
    }
  }])
}

# One-off tasks with the same image and config: migrations by default, and the
# demo seed via a command override (see run-task.sh).
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name        = "app"
    image       = local.image
    essential   = true
    command     = ["node", "scripts/migrate.ts"]
    environment = local.container_env
    secrets     = local.container_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.app.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "ops"
      }
    }
  }])
}

# --- Service ---------------------------------------------------------------------------
resource "aws_ecs_service" "app" {
  name                              = var.name
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.app.arn
  desired_count                     = var.desired_count
  launch_type                       = "FARGATE"
  health_check_grace_period_seconds = 30

  # Rolling deploy: start the new task, wait for it to pass health checks,
  # then stop the old one. Roll back automatically if it never gets healthy.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true # no NAT: the public IP is how tasks reach ECR, Secrets Manager and ifthenpay
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = 8080
  }

  depends_on = [aws_lb_listener.http, aws_iam_role_policy.execution_secrets]
}
