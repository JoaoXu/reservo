output "region" { value = var.region }
output "url" { value = local.public_base_url }
output "demo_url" { value = local.demo_url }
output "name_servers" {
  description = "Set these at the registrar when route53_zone is used"
  value       = local.route53 ? aws_route53_zone.main[0].name_servers : []
}
output "seed_extra_domains" {
  description = "Extra demo domain: the ALB hostname while there is no HTTPS"
  value       = local.https ? "" : aws_lb.main.dns_name
}
output "alb_dns_name" { value = aws_lb.main.dns_name }
output "ecr_repository_url" { value = aws_ecr_repository.app.repository_url }
output "cluster" { value = aws_ecs_cluster.main.name }
output "service" { value = aws_ecs_service.app.name }
output "migrate_task_family" { value = aws_ecs_task_definition.migrate.family }
output "task_subnets" { value = join(",", aws_subnet.public[*].id) }
output "task_security_group" { value = aws_security_group.app.id }
output "log_group" { value = aws_cloudwatch_log_group.app.name }
output "db_endpoint" { value = aws_db_instance.pg.address }
output "data_key_secret" {
  value       = aws_secretsmanager_secret.s["DATA_ENCRYPTION_KEY"].name
  description = "Back this value up outside AWS (see README.md)"
}
output "acm_validation_records" {
  description = "CNAMEs to add at your DNS provider after setting domain_name"
  value = var.domain_name == "" ? [] : [
    for o in aws_acm_certificate.main[0].domain_validation_options : { name = o.resource_record_name, type = o.resource_record_type, value = o.resource_record_value }
  ]
}
