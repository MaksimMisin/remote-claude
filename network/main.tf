terraform {
  required_version = ">= 1.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

locals {
  fqdn = "${var.custom_subdomain}.${var.domain}"
}

# Generate a secret for the tunnel
resource "random_string" "tunnel_secret" {
  length  = 32
  special = false
}

# Get the zone ID for the domain
data "cloudflare_zone" "domain" {
  name = var.domain
}

# Create a Cloudflare Tunnel (Zero Trust)
resource "cloudflare_zero_trust_tunnel_cloudflared" "remote_claude" {
  account_id = var.cloudflare_account_id
  name       = "remote-claude-tunnel"
  secret     = base64encode(random_string.tunnel_secret.result)
}

# Configure the tunnel to route traffic to the Remote Claude server
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "remote_claude" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.remote_claude.id

  config {
    ingress_rule {
      hostname = local.fqdn
      service  = "http://localhost:4080"
    }
    # Catch-all rule (required)
    ingress_rule {
      service = "http_status:404"
    }
  }
}

# DNS record pointing subdomain to the tunnel
resource "cloudflare_record" "remote_claude" {
  zone_id = data.cloudflare_zone.domain.id
  name    = var.custom_subdomain
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.remote_claude.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1 # Auto TTL when proxied
}

# Cloudflare Access application to protect the dashboard
resource "cloudflare_zero_trust_access_application" "remote_claude" {
  zone_id                   = data.cloudflare_zone.domain.id
  name                      = "Remote Claude Dashboard"
  domain                    = local.fqdn
  type                      = "self_hosted"
  session_duration          = "720h"
  auto_redirect_to_identity = true
}

# Access policy: allow only the specified GitHub user
resource "cloudflare_zero_trust_access_policy" "remote_claude" {
  zone_id        = data.cloudflare_zone.domain.id
  application_id = cloudflare_zero_trust_access_application.remote_claude.id
  name           = "GitHub login"
  decision       = "allow"
  precedence     = 1

  include {
    github {
      name = var.github_username
    }
  }
}
