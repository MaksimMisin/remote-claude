# Design Doc: Exposing Remote Claude on the Internet

**Status:** Draft
**Date:** 2025-02-08
**Goal:** Access the Remote Claude dashboard from outside the home network at `claude.maksim.xyz`

---

## Current State

Remote Claude is a **zero-auth, LAN-only** dashboard. The server:
- Binds to `0.0.0.0:4080` (all interfaces)
- Has no authentication on any endpoint
- Uses wildcard CORS (`Access-Control-Allow-Origin: *`)
- Exposes sensitive operations: tmux command injection, session control, directory listing
- Broadcasts all session data over unauthenticated WebSocket

This is fine for localhost/LAN use but **catastrophic if exposed directly to the internet** -- anyone who finds the URL gets arbitrary code execution via the tmux prompt endpoint.

## Existing Infrastructure Pattern

The home-assistant repo already establishes a pattern:
- **Cloudflare Tunnel** (Zero Trust) via Terraform IaC
- DNS: `myhouse.maksim.xyz` → CNAME → `<tunnel-id>.cfargotunnel.com`
- `cloudflared` agent runs locally, tunnels traffic to the service
- No home IP exposed, automatic TLS, Cloudflare DDoS protection

We follow the exact same pattern for Remote Claude.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  INTERNET                                                       │
│                                                                 │
│  Browser (phone) ──HTTPS──► Cloudflare Edge                     │
│                              │                                  │
│                              ▼                                  │
│                        Cloudflare Access                        │
│                        (email OTP / GitHub)                     │
│                              │                                  │
│                              ▼                                  │
│                        Cloudflare Tunnel                        │
│                              │                                  │
└──────────────────────────────┼──────────────────────────────────┘
                               │ (encrypted tunnel)
┌──────────────────────────────┼──────────────────────────────────┐
│  HOME MACHINE                │                                  │
│                              ▼                                  │
│                        cloudflared agent ──► localhost:4080      │
│                                                    ▲            │
│                                                    │            │
│    Claude Code ──hook──► hook script ──POST /event──┘           │
│                          (localhost, no auth needed)             │
└─────────────────────────────────────────────────────────────────┘
```

**Key insight:** The hook script always POSTs to `localhost:4080` directly, bypassing Cloudflare entirely. Only browser traffic goes through the tunnel. This means:
- Hook → server path: no auth needed (it's local)
- Browser → server path: authenticated by Cloudflare Access at the edge

---

## What Cloudflare Gives Us (Free)

| Concern | Handled by |
|---|---|
| TLS/HTTPS | Cloudflare automatic certificates |
| DDoS protection | Cloudflare edge network |
| IP concealment | Tunnel (no open ports at home) |
| Authentication | Cloudflare Access (Zero Trust) |
| WebSocket proxying | Cloudflare Tunnel (supports WS natively) |
| Rate limiting | Basic rate limiting on free tier |

## What We Still Need to Do

### 1. Bind to localhost only (server change)

Change `0.0.0.0` → `127.0.0.1` in `server/index.ts`. Since `cloudflared` runs on the same machine, it connects to localhost. This eliminates LAN exposure entirely -- the only way in from outside is through the tunnel.

```typescript
// Before
server.listen(SERVER_PORT, '0.0.0.0', () => { ... });

// After
server.listen(SERVER_PORT, '127.0.0.1', () => { ... });
```

**Trade-off:** If you sometimes access the dashboard from another machine on your LAN (e.g., desktop → laptop), this breaks that. Options:
- Use the Cloudflare URL even on LAN (adds ~50ms latency)
- Make the bind address configurable via env var: `BIND_HOST=0.0.0.0 npm run dev`

### 2. Protect the `/event` endpoint

The `/event` endpoint accepts arbitrary event data. Through the tunnel, an attacker could inject fake events. Since the hook script always posts from localhost, we can gate this endpoint:

**Option A -- Check for Cloudflare headers (simple):**
```typescript
if (url === '/event' && method === 'POST') {
  // cloudflared adds CF-Connecting-IP for tunnel traffic
  // localhost hook requests won't have this header
  if (req.headers['cf-connecting-ip']) {
    return error(res, 'Forbidden', 403);
  }
  // ... existing logic
}
```

**Option B -- Shared secret (defense in depth):**
Add `X-Hook-Secret` header to `remote-claude-hook.sh`, validate in server. Generate the secret at setup time, store in `~/.remote-claude/data/hook-secret.txt`.

Recommendation: **Do both.** Option A as the primary gate, Option B as defense in depth. Low effort, high value.

### 3. Lock down CORS

Replace wildcard CORS with the actual origin:

```typescript
const ALLOWED_ORIGIN = process.env.CORS_ORIGIN || 'https://claude.maksim.xyz';

// In json() helper and serveStatic():
'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
```

For local development, override with `CORS_ORIGIN=http://localhost:5173`.

### 4. Add security headers

Standard headers for the static file responses and API:

```typescript
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};
```

No need for HSTS (Cloudflare handles it) or CSP (adds complexity, low value for a single-user dashboard).

### 5. Cloudflare Access policy (Terraform)

This is the main authentication layer. Options for the access policy:

| Method | Pros | Cons |
|---|---|---|
| **Email OTP** | Simple, no external deps | Must check email each time |
| **GitHub OAuth** | One-click, natural for devs | Requires GH auth app setup |
| **Google OAuth** | One-click if using Gmail | Requires Google Cloud project |
| **Service token** | Headless, no login flow | Less secure if token leaks |

**Recommendation: GitHub OAuth.** You're a developer, it's one-click, and Cloudflare Access supports it natively. Restrict to your GitHub username only.

Session duration: **24 hours** (re-authenticate once a day). Reasonable for a monitoring dashboard.

### 6. Terraform infrastructure

Create `network/` directory in remote-claude repo (mirroring the HA pattern):

```
network/
├── main.tf           # Tunnel, DNS, Access policy
├── variables.tf      # cloudflare creds, domain
├── outputs.tf        # Tunnel token, URL
├── terraform.tfvars  # Actual values (gitignored)
└── .gitignore        # State files, tfvars
```

**Key resources:**
- `cloudflare_zero_trust_tunnel_cloudflared` -- new tunnel
- `cloudflare_zero_trust_tunnel_cloudflared_config` -- ingress: `claude.maksim.xyz` → `http://localhost:4080`
- `cloudflare_record` -- CNAME for `claude` subdomain
- `cloudflare_zero_trust_access_application` -- Access app for `claude.maksim.xyz`
- `cloudflare_zero_trust_access_policy` -- Allow policy (GitHub identity)

### 7. Run cloudflared as a service

On macOS, install and run `cloudflared` as a launch agent:

```bash
brew install cloudflared
cloudflared service install <TUNNEL_TOKEN>
# Creates ~/Library/LaunchAgents/com.cloudflare.cloudflared.plist
```

This starts cloudflared on boot automatically.

---

## What Does NOT Need to Change

| Component | Why it's fine |
|---|---|
| WebSocket auth | Cloudflare Access validates the HTTP upgrade request (CF_Authorization cookie) |
| WebSocket keepalive | 30s ping interval, well within Cloudflare's 100s idle timeout |
| Hook script | Posts to localhost:4080 directly, never touches the tunnel |
| Session management | All tmux operations are local, no change needed |
| Frontend code | Works as-is; WS URL is relative (`/ws`), adapts to any host |
| Image uploads | Still local-only (hook → server), not exposed through tunnel |
| Rate limiting | Cloudflare provides edge rate limiting; app-level not critical for single-user |

---

## Risk Assessment

### What Cloudflare Access protects against
- Unauthenticated access to the dashboard
- Random port scanners (no ports exposed)
- Brute force (Cloudflare handles login attempts)
- Session hijacking (CF_Authorization is httpOnly, secure, SameSite)

### Residual risks (accepted)
- **Cloudflare compromise:** If Cloudflare itself is compromised, traffic is exposed. Acceptable -- we trust Cloudflare for HA too.
- **cloudflared token leak:** If the tunnel token leaks, an attacker can tunnel traffic. Mitigated by Cloudflare Access (still need to authenticate).
- **GitHub account compromise:** Attacker with access to your GitHub account could authenticate. Mitigated by GitHub 2FA.
- **Local privilege escalation:** If someone gets shell on the machine, they can hit localhost:4080 directly. Accepted -- they already have shell access.

### What this design explicitly does NOT add (and why)
- **App-level auth (bearer tokens, sessions):** Cloudflare Access is sufficient for single-user. Adding a second auth layer adds complexity with no real security gain.
- **HTTPS in Node.js:** Cloudflare handles TLS termination. Tunnel traffic is encrypted end-to-end.
- **Request signing:** Over-engineering for a personal dashboard.
- **Encryption at rest:** Event logs contain tool invocations, not secrets. Acceptable risk.

---

## Implementation Plan

### Phase 1: Server hardening (code changes, ~30 min)
1. Bind to `127.0.0.1` (with `BIND_HOST` env var override)
2. Protect `/event` endpoint (CF header check + hook secret)
3. Lock down CORS
4. Add security headers
5. Rebuild frontend

### Phase 2: Cloudflare infrastructure (Terraform, ~30 min)
1. Create `network/` directory with Terraform config
2. Set up Cloudflare Tunnel for `claude.maksim.xyz`
3. Set up Cloudflare Access policy (GitHub OAuth)
4. Apply Terraform, get tunnel token

### Phase 3: Deployment (~15 min)
1. Install `cloudflared` via Homebrew
2. Configure with tunnel token
3. Start as launch agent
4. Test from phone on cellular (not WiFi)

---

## Open Questions

1. **LAN access:** Do you ever access the dashboard from another machine on your LAN? If so, we need the `BIND_HOST` env var or a way to keep LAN access working alongside the tunnel.

2. **Same tunnel vs. separate tunnel:** We could add an ingress rule to the existing HA tunnel instead of creating a new one. Simpler infra (one cloudflared process), but couples the two projects. Recommendation: separate tunnel (clean separation, independent lifecycle).

3. **Terraform location:** The `network/` directory in remote-claude is clean and self-contained, but you'd need to duplicate `cloudflare_api_token` and `cloudflare_account_id`. Alternatively, manage all DNS/tunnels from the HA repo. What's your preference?

4. **Access policy scope:** Should the Access policy protect only the dashboard, or also the API endpoints? Cloudflare Access can be scoped to specific paths. Recommendation: protect everything (`claude.maksim.xyz/*`) -- simpler and more secure.
