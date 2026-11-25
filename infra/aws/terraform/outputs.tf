output "region" { value = var.region }
output "instance_id" { value = aws_instance.server.id }
output "public_ip" { value = aws_eip.server.public_ip }
output "ops_bucket" { value = aws_s3_bucket.ops.bucket }
output "ecr_registry" { value = split("/", aws_ecr_repository.app["api"].repository_url)[0] }
output "ecr_prefix" { value = var.project }
output "base_domain" { value = local.base_domain }
output "admin_allowed_cidrs" { value = join(" ", var.admin_allowed_cidrs) }

output "urls" {
  value = {
    web   = "https://app.${local.base_domain}"
    api   = "https://api.${local.base_domain}"
    admin = "https://admin.${local.base_domain}"
  }
}
