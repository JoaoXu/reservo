# --- RDS PostgreSQL 16 -------------------------------------------------------------
resource "random_password" "db" {
  length  = 32
  special = false # goes into a URL
}

resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "pg16" {
  name   = "${var.name}-pg16"
  family = "postgres16"
  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot" # static parameter; AWS reports it this way
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "500" # log queries slower than 500 ms
  }
}

resource "aws_db_instance" "pg" {
  identifier     = "${var.name}-pg"
  engine         = "postgres"
  engine_version = "16" # latest 16.x; minor upgrades applied in the maintenance window
  instance_class = var.db_instance_class

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "reservo"
  username = "reservo"
  password = random_password.db.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.pg16.name
  publicly_accessible    = false
  multi_az               = false # true doubles the cost; worth it once studios depend on it

  backup_retention_period    = 7
  backup_window              = "02:00-03:00"         # UTC
  maintenance_window         = "sun:03:30-sun:04:30" # UTC
  auto_minor_version_upgrade = true
  copy_tags_to_snapshot      = true

  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-pg-final"

  lifecycle { prevent_destroy = true }
}
