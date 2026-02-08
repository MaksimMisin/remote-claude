# Remote Claude - Cloudflare Tunnel + Access

Terraform configuration to expose the Remote Claude dashboard securely via
Cloudflare Tunnel with Zero Trust Access (email one-time PIN authentication).

Public URL: `https://claude.maksim.xyz`

## Prerequisites

1. Domain (`maksim.xyz`) with nameservers pointed to Cloudflare
2. Cloudflare account
3. Terraform installed (`brew install terraform`)
4. cloudflared installed (`brew install cloudflared`)

## First-time Cloudflare Setup (manual, one-time)

These steps cannot be automated with Terraform:

1. **Enable Zero Trust Access:**
   Go to [one.dash.cloudflare.com](https://one.dash.cloudflare.com/) →
   click "Enable Access" if prompted. This is required before Access
   applications can be created via Terraform. The "One-time PIN" login
   method is enabled by default (no identity provider setup needed).

2. **Create an API token** (if you don't have one):
   [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) →
   Create Token with these permissions:
   - Zone → DNS → Edit
   - Account → Cloudflare Tunnel → Edit
   - Account → Access: Apps and Policies → Edit

## Deploy

### 1. Configure variables

```bash
cd network/
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values:
#   cloudflare_api_token  = "your-token"
#   cloudflare_account_id = "your-account-id"
#   allowed_emails        = ["you@example.com"]
```

### 2. Initialize and apply

```bash
terraform init
terraform plan    # review what will be created
terraform apply   # creates tunnel, DNS record, Access app + policy
```

This creates 6 resources:
- Cloudflare Tunnel (`remote-claude-tunnel`)
- Tunnel config (routes `claude.maksim.xyz` → `localhost:4080`)
- DNS CNAME record (`claude` → tunnel)
- Access Application (30-day sessions)
- Access Policy (allow only your email addresses via one-time PIN)
- Random tunnel secret

### 3. Install cloudflared service

```bash
# Get the tunnel token
terraform output -raw tunnel_token

# Install as a system service (auto-starts on boot)
sudo cloudflared service install <TOKEN>
```

This creates a launchd service that runs cloudflared on boot.

To verify it's running:
```bash
sudo launchctl list | grep cloudflare
# or check the logs:
tail -f /Library/Logs/com.cloudflare.cloudflared.log
```

### 4. Start the Remote Claude server

The server must be running on `localhost:4080` for the tunnel to work:

```bash
cd /path/to/remote-claude
npm run dev     # development (hot reload)
# or
npm run start   # production
```

## Verify

```bash
# Check tunnel is connected
terraform output dashboard_url
# → https://claude.maksim.xyz

# Check server is reachable through tunnel
curl -s https://claude.maksim.xyz/health
```

Visit `https://claude.maksim.xyz` — Cloudflare Access will show a login
page. Enter your email, check for the one-time PIN code, and you're in
for 30 days.

## Ongoing Operations

### Re-apply after changes
```bash
cd network/
terraform apply
```

### View tunnel token (e.g. after re-install)
```bash
terraform output -raw tunnel_token
```

### Destroy everything
```bash
terraform destroy
sudo cloudflared service uninstall
```

### Cloudflared service management
```bash
# Check status
sudo launchctl list | grep cloudflare

# Restart
sudo launchctl kickstart -k system/com.cloudflare.cloudflared

# Uninstall
sudo cloudflared service uninstall
```

## Environment Variables (server)

| Variable | Default | Description |
|---|---|---|
| `BIND_HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` for localhost-only |
| `CORS_ORIGIN` | `*` | Allowed CORS origin. Set to `https://claude.maksim.xyz` in production |

## Security Notes

- The tunnel exposes `localhost:4080` through Cloudflare's network — no ports are opened on your router
- Cloudflare Access (email OTP, 30-day sessions) gates all external traffic
- The `/event` endpoint (used by hooks) blocks requests coming through the tunnel (`CF-Connecting-IP` header check)
- A shared hook secret (`~/.remote-claude/data/hook-secret.txt`) provides defense-in-depth
- LAN access (`http://<local-ip>:4080`) still works as a fallback and is unauthenticated
- See `docs/INTERNET-EXPOSURE.md` for the full design doc and threat model
