# Happy OpenClaw - Project Documentation

## Overview
Fork of Happy CLI (`happy-openclaw-app`) that adds an OpenClaw Gateway backend.
Repo: `git@github.com:biodoia/happy-openclaw-app.git`
Local: `/mnt/godata/projects/happy-openclaw-app/packages/happy-cli/`

## What It Does
Connects to a running OpenClaw Gateway via WebSocket, bridging Happy's AgentMessage protocol to OpenClaw's Gateway protocol. Enables remote control of OpenClaw sessions from mobile/web.

## Architecture
```
Happy Mobile App <-> Happy Server <-> OpenClawBackend <-(WebSocket)-> OpenClaw Gateway <-> LLM
```

## Key Files

### `src/openclaw/OpenClawBackend.ts` (main backend)
- WebSocket client connecting to OpenClaw Gateway
- Challenge-response auth with Ed25519 device keys
- v2 signed payload format
- Maps gateway events to Happy AgentMessage types
- Handles: agent lifecycle, text streaming, tool calls, chat state, permissions

### `src/openclaw/runOpenClaw.ts`
- Factory function `createOpenClawBackend(config)`
- `registerOpenClawAgent()` for agent registry

### `src/openclaw/index.ts`
- Module re-exports

### `src/index.ts` (lines ~345-424)
- `openclaw` / `claw` subcommand handler
- Parses `--gateway-url`, `--token`, `--session` args
- Connects backend, sets up message handler for console output
- Interactive readline loop with `🦞 >` prompt
- Auth/daemon startup intentionally removed (not needed for direct gateway connection)

## Build & Run
```bash
cd /mnt/godata/projects/happy-openclaw-app/packages/happy-cli
yarn build
node --no-warnings --no-deprecation dist/index.mjs openclaw
# Optional: --gateway-url ws://host:port/ws --token TOKEN --session SESSION_KEY
```

## Current State (2026-02-27)

### Working (VERIFIED E2E)
- WebSocket connection to gateway
- Challenge-response device authentication (Ed25519)
- Token auto-loading from `~/.openclaw/openclaw.json` (config > env var priority)
- `chat.send` RPC with sessionKey + idempotencyKey
- **Text streaming**: gateway sends `stream: "assistant"` events with `data.delta` / `data.text`
- **Chat state events**: `state: "delta"` (streaming), `state: "final"` (complete), `state: "error"`
- **Lifecycle events**: `stream: "lifecycle"` with `data.phase: "start"/"end"/"error"`
- Error display in CLI (red `[OpenClaw] Error:` messages)
- `chat.abort` for cancellation
- `exec.approval.resolve` for permission responses
- Build passes TypeScript checks cleanly
- **Tested with Gemini 3 Flash Preview** — responses stream correctly to CLI

### Pending / TODO
1. **Graceful reconnection** — backend throws unhandled error when gateway disconnects (e.g. on restart). Should auto-reconnect or show clean error.
2. **Tool call event format** — handler expects `stream: "tool"` with `data.phase: "start"/"end"`. Untested — actual gateway format may differ.
3. **Integration with Happy mobile** — currently only CLI readline mode. Need to wire up to Happy's remote session system.
4. **Permission flow** — `exec.approval.requested` event handling is written but untested.
5. **Multiple sessions** — currently hardcoded to sessionKey "main".
6. **Longer response streaming** — tested with single-word responses. Need to verify multi-chunk streaming works.

### Recently Fixed (2026-02-27)
- **Event handling bug**: was checking `data.type === 'error'` but gateway sends `stream: "lifecycle"` with `data.phase: "error"`. Fixed to use stream-based dispatch.
- **Chat error events**: was checking `p.type === 'done'` but gateway sends `p.state: "error"` with `p.errorMessage`. Fixed.
- **Token mismatch bug**: stale `OPENCLAW_GATEWAY_TOKEN` env var from old systemd service took priority. Fixed token resolution order: `config.token || loadGatewayToken() || process.env`.
- **TypeScript errors**: created `OpenClawSocket` interface, `WS_OPEN` constant, `createSocket()` factory to avoid WebSocket type conflicts.

## Gateway Event Format (from wire captures)

### Agent lifecycle events
```json
{"type":"event","event":"agent","payload":{
  "runId":"uuid","stream":"lifecycle",
  "data":{"phase":"start","startedAt":1772205053663},
  "sessionKey":"agent:main:main","seq":1
}}
```
```json
{"type":"event","event":"agent","payload":{
  "runId":"uuid","stream":"lifecycle",
  "data":{"phase":"error","error":"error message","endedAt":1772205054275},
  "sessionKey":"agent:main:main","seq":2
}}
```

### Chat state events
```json
{"type":"event","event":"chat","payload":{
  "runId":"uuid","sessionKey":"agent:main:main",
  "state":"error","errorMessage":"error message"
}}
```

### chat.send RPC response
```json
{"type":"res","id":"uuid","ok":true,"payload":{
  "runId":"uuid","status":"started"
}}
```

### Text streaming (VERIFIED)
```json
{"type":"event","event":"agent","payload":{
  "runId":"uuid","stream":"assistant",
  "data":{"text":"Ciao.","delta":"Ciao."},
  "sessionKey":"agent:main:main","seq":2
}}
```
Note: stream is "assistant" NOT "text"!

### Chat delta/final events (VERIFIED)
```json
{"type":"event","event":"chat","payload":{
  "runId":"uuid","sessionKey":"agent:main:main",
  "state":"delta",
  "message":{"role":"assistant","content":[{"type":"text","text":"Ciao."}]}
}}
```
```json
{"type":"event","event":"chat","payload":{
  "runId":"uuid","sessionKey":"agent:main:main",
  "state":"final",
  "message":{"role":"assistant","content":[{"type":"text","text":"Ciao."}]}
}}
```
