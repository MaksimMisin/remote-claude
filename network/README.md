# Remote Claude - Cloudflare Tunnel + Access

Terraform configuration to expose the Remote Claude dashboard securely via Cloudflare Tunnel with Zero Trust Access (GitHub authentication).

## Prerequisites

1. Domain (example.com) with nameservers pointed to Cloudflare
2. Cloudflare account with Zero Trust enabled
3. Terraform installed
4. GitHub identity provider configured in Cloudflare Zero Trust

## Setup

### 1. Configure variables

```bash
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values
```

### 2. Deploy infrastructure

```bash
terraform init
terraform plan
terraform apply
```

### 3. Get the tunnel token

```bash
terraform output -raw tunnel_token
```

### 4. Install and run cloudflared

```bash
brew install cloudflared
sudo cloudflared service install <TOKEN>
```

## Access

```bash
terraform output dashboard_url
```

Visit the URL -- Cloudflare Access will redirect to GitHub for authentication. Only the configured GitHub user is allowed access.
