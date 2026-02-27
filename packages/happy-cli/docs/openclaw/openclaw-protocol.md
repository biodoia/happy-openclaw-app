# OpenClaw Gateway WebSocket Protocol Reference

## Connection
- Default URL: `ws://127.0.0.1:18789/ws`
- Protocol: JSON frames, one per WebSocket message
- Frame types: `req` (client->server), `res` (server->client), `event` (server->client)

## Handshake Flow
1. Client opens WebSocket
2. Gateway sends `event: connect.challenge` with `{ nonce: "uuid" }`
3. Client sends `req: connect` with signed device auth
4. Gateway responds with `res: hello-ok` (includes granted scopes, features, etc.)

## Valid Constants

### Client IDs (`GATEWAY_CLIENT_IDS`)
`cli`, `webchat`, `openclaw-control-ui`, `webchat-ui`, `gateway-client`, `openclaw-macos`, `openclaw-ios`, `openclaw-android`, `node-host`, `test`, `fingerprint`, `openclaw-probe`

### Client Modes (`GATEWAY_CLIENT_MODES`)
`cli`, `ui`, `webchat`, `backend`, `node`, `probe`, `test`

**Note**: "operator" is a ROLE, not a mode. Using it as mode will be rejected.

### Roles
`operator`, `viewer` (maybe others)

### Scopes
`operator.read`, `operator.write`

## Device Authentication (v2)

### Identity file: `~/.openclaw/identity/device.json`
```json
{
  "deviceId": "hex(sha256(raw_32byte_ed25519_pubkey))",
  "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...",
  "privateKeyPem": "-----BEGIN PRIVATE KEY-----\n..."
}
```

### Signature payload format
```
v2|{deviceId}|{clientId}|{clientMode}|{role}|{scopes_csv}|{signedAtMs}|{token}|{nonce}
```
- Sign with Ed25519 private key
- Encode signature as **base64url** (NOT regular base64)

### Public key encoding
- Extract raw 32-byte key from SPKI DER (last 32 bytes after 12-byte header)
- Encode as **base64url**

### Connect request params
```json
{
  "minProtocol": 3, "maxProtocol": 3,
  "client": { "id": "cli", "version": "1.0.0", "platform": "linux", "mode": "cli" },
  "role": "operator",
  "scopes": ["operator.read", "operator.write"],
  "caps": [], "commands": [], "permissions": {},
  "locale": "en-US", "userAgent": "happy-openclaw/1.0.0",
  "auth": { "token": "gateway_token_here" },
  "device": {
    "id": "device_id_hex",
    "publicKey": "raw_32bytes_base64url",
    "signature": "signed_payload_base64url",
    "signedAt": 1772205053137,
    "nonce": "nonce_from_challenge"
  }
}
```

## RPC Methods

### chat.send
```json
{ "method": "chat.send", "params": {
  "sessionKey": "main",
  "message": "user message",
  "idempotencyKey": "uuid"
}}
```
Response: `{ "runId": "uuid", "status": "started" }`

### chat.abort (NOT chat.cancel)
```json
{ "method": "chat.abort", "params": { "sessionKey": "main" } }
```

### exec.approval.resolve
```json
{ "method": "exec.approval.resolve", "params": { "id": "request_id", "approved": true } }
```

## Event Streams

### agent events (`event: "agent"`) — VERIFIED
Uses `payload.stream` to distinguish event type:
- `"lifecycle"` — `data.phase`: `"start"`, `"end"`, `"error"`
- `"assistant"` — `data.text` / `data.delta`: streaming text content (NOT "text"!)
- `"tool"` — tool call events (untested, expected: phase start/call, end/result)
- `"error"` — protocol errors (seq gaps etc.), can be ignored

### chat events (`event: "chat"`) — VERIFIED
- `payload.state`: `"delta"` (streaming), `"final"` (complete), `"error"`
- `payload.errorMessage`: error detail string (when state="error")
- `payload.message`: `{ role, content: [{ type, text }], timestamp }` (when state="delta"/"final")

### Other events
- `health` — periodic health check (noisy, ignore)
- `tick` — periodic tick (noisy, ignore)
- `connect.challenge` — connection challenge (handled during handshake)
- `exec.approval.requested` — permission request from agent

## Token Configuration
- Config file: `~/.openclaw/openclaw.json` → `gateway.auth.token`
- Env var: `OPENCLAW_GATEWAY_TOKEN`
- **Priority**: config file should take precedence over env var (stale systemd env vars can cause token mismatch)

## Model Configuration
- Config file: `~/.openclaw/openclaw.json` → `agents.defaults.model.primary`
- Format: `provider/model-name` (e.g., `google/gemini-2.0-flash`, `anthropic/claude-opus-4-6`)
- API keys: `~/.openclaw/.env` (e.g., `GEMINI_API_KEY=...`)

## Source Code Reference (OpenClaw Gateway)
- Client constants: search for `GATEWAY_CLIENT_MODES` and `GATEWAY_CLIENT_IDS`
- Auth payload builder: `buildDeviceAuthPayload()` function
- Located in OpenClaw gateway source (not in happy-openclaw-app)
