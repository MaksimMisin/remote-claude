variable "cloudflare_api_token" {
  description = "Cloudflare API token with Zone:Edit, Tunnel:Edit, and Access:Edit permissions"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare account ID"
  type        = string
}

variable "domain" {
  description = "Base domain name"
  type        = string
  default     = "example.com"
}

variable "custom_subdomain" {
  description = "Subdomain for Remote Claude dashboard"
  type        = string
  default     = "claude"
}

variable "allowed_emails" {
  description = "Email addresses allowed to access the dashboard"
  type        = list(string)
}
