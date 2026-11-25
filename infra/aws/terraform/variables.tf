variable "project" {
  description = "Name prefix for every resource."
  type        = string
  default     = "moneymgr"
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "ap-southeast-1" # Singapore
}

variable "instance_type" {
  description = "ARM (Graviton) instance. t4g.small (2 GB) runs everything comfortably; t4g.micro (1 GB) is cheaper but tight even with swap."
  type        = string
  default     = "t4g.small"
}

variable "root_volume_gb" {
  description = "System disk (OS, Docker images)."
  type        = number
  default     = 20
}

variable "data_volume_gb" {
  description = "Separate disk for the database, Redis, receipts, certificates and secrets. Survives instance replacement."
  type        = number
  default     = 10
}

variable "domain" {
  description = "Your own domain (optional). Empty = free <ip>.sslip.io names. When set, point app./api./admin.<domain> A records at the Elastic IP."
  type        = string
  default     = ""
}

variable "admin_allowed_cidrs" {
  description = "IP ranges allowed to open the admin dashboard (e.g. [\"203.0.113.7/32\"]). Empty = anyone can reach the sign-in page (2FA still required)."
  type        = list(string)
  default     = []
}

variable "backup_retention_days" {
  description = "How long nightly database backups are kept in S3."
  type        = number
  default     = 30
}

variable "monthly_budget_usd" {
  description = "Send an email when the month's forecast spend passes this. 0 = no budget alert."
  type        = number
  default     = 30
}

variable "budget_alert_email" {
  description = "Where budget alerts go (needed for the alert to be created)."
  type        = string
  default     = ""
}
