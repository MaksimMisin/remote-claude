# Remote Claude

Monitor and control [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions remotely via a mobile web dashboard and Telegram.

Claude Code runs in tmux panes on your machine. A hook script captures events and sends them to a local server, which streams them to a React dashboard and optionally to Telegram forum topics.

## Setup

```bash
npm install
npm run setup   # installs hooks + generates auth token
npm run dev     # starts server on :4080
```

Optional: set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env` for Telegram notifications.

## Structure

- `hooks/` -- Claude Code hook script (bash + jq)
- `server/` -- Node.js + TypeScript server (HTTP + WebSocket + Telegram)
- `frontend/` -- React + Vite mobile-first dashboard
- `network/` -- Cloudflare Tunnel + Access terraform config
- `docs/` -- Architecture and design docs
