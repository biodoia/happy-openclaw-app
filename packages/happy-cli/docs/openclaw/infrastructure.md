# Infrastructure & Local Services

## OpenClaw Gateway
- Service: `systemd --user openclaw-gateway.service`
- Version: 2026.2.24
- Port: 18789 (HTTP + WebSocket at `/ws`)
- Canvas: `http://127.0.0.1:18789/__openclaw__/canvas/`
- Config: `~/.openclaw/openclaw.json`
- Env: `~/.openclaw/.env`
- Device identity: `~/.openclaw/identity/device.json`
- Control: `systemctl --user start/stop/restart openclaw-gateway.service`
- Logs: `journalctl --user -u openclaw-gateway.service -f`
- Current model: `google/gemini-3-flash-preview` (working as of 2026-02-27, gemini-2.0-flash free tier exhausted)
- Gateway token: starts with `8528c890...` (from config file)

### Token Gotcha
Old systemd service versions may set `OPENCLAW_GATEWAY_TOKEN` env var that persists in tmux sessions.
Always check `echo $OPENCLAW_GATEWAY_TOKEN` in the shell where you run happy-openclaw.
The env var `bf49251b...` is STALE and from an old version. The correct token is in the config file.

## Goleciave (Secrets Manager)
- Repo: `git@github.com:biodoia/goleciave.git`
- Binary: `/tmp/goleciave-bin` (may need rebuild if /tmp cleared)
- Source: `/tmp/goleciave/`
- Vault: `~/lisergico25/.goleciave/vault.enc`
- Key: `~/lisergico25/.goleciave/key`
- Usage: `GOLECIAVE_HOME= not needed, use explicit paths`
```bash
/tmp/goleciave-bin list --vault ~/lisergico25/.goleciave/vault.enc --key ~/lisergico25/.goleciave/key
/tmp/goleciave-bin get SECRET_NAME --vault ~/lisergico25/.goleciave/vault.enc --key ~/lisergico25/.goleciave/key
```

### Available Secrets
- `GEMINI_API_KEY` — AIzaSyAdigbp8KRbQAM_1p_qqSEsoX1ckme7wwE (free tier, rate limited)
- `GITHUB_TOKEN`
- `MEMOGO_DB_PASSWORD`
- `MEMOGO_JWT_SECRET`
- `SERGO_WEB_PASSWORD`
- `SERGO_WEB_SECRET_KEY`
- `TAILSCALE_AUTH_KEY`
- `TELEGRAM_ALLOWED_USERS`
- `TELEGRAM_BOT_TOKEN`
- **No ANTHROPIC_API_KEY or OPENAI_API_KEY available**

## Tmux Sessions
- `happy-oc` — Happy OpenClaw CLI (may need restart)
- `monitor` — general monitoring
- `openclaw-tui` — OpenClaw TUI client
- `ultraralph-2` — other project

## Git Repos
- Happy fork: `/home/lisergico25/happy-openclaw-app/` → `biodoia/happy-openclaw-app`
- Casino bot: has its own repo (completed and pushed)
- AgentAPI fork: `biodoia/happy-openclaw` (Go-based, with OpenClaw TUI support, completed)

## System
- OS: Manjaro Linux (6.12.68-1-MANJARO)
- Node: v25.4.0
- Platform: x870 desktop
- Shell: zsh (but tmux sessions may use bash)
