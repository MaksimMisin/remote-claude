output "tunnel_token" {
  description = "Tunnel token for cloudflared"
  value       = cloudflare_zero_trust_tunnel_cloudflared.remote_claude.tunnel_token
  sensitive   = true
}

output "dashboard_url" {
  description = "Public URL to access Remote Claude dashboard"
  value       = "https://${local.fqdn}"
}

output "subdomain" {
  description = "The subdomain being used"
  value       = var.custom_subdomain
}
