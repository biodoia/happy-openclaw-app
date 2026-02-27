# Research Links & Alternative Projects

## Reference Projects (shared by user 2026-02-27)

### HAPI — Decentralized Self-Hosted Happy Alternative
- URL: https://github.com/tiann/hapi
- Docs: https://github.com/tiann/hapi/blob/main/docs/guide/why-hapi.md
- What: Each user runs their own hub locally (vs Happy's centralized server)
- Architecture: Single binary, embedded SQLite, data stays on device
- Remote access: Self-hosted HTTPS or public relay with WireGuard + E2E encryption
- Relevance: Same problem space as Happy OpenClaw — remote agent control with data sovereignty

### AgentAPI — HTTP Wrapper for Coding Agents
- URL: https://github.com/coder/agentapi
- By: Coder (the company behind code-server)
- What: Unified REST API to control multiple coding agents (Claude Code, Goose, Aider, Gemini, Copilot, etc.)
- Architecture: In-memory terminal emulator, translates HTTP to keystrokes, parses terminal output into messages
- Endpoints: GET `/messages`, POST `/message`, GET `/status`, GET `/events` (SSE)
- Default port: 3284
- Relevance: Different approach — terminal scraping vs native protocol integration
- Key insight: agent-agnostic via terminal emulation vs our protocol-specific approach

## Architecture Comparison

| Feature | Happy OpenClaw | HAPI | AgentAPI |
|---------|---------------|------|----------|
| Integration | Native WebSocket protocol | Self-hosted hub | Terminal emulation |
| Agent support | OpenClaw only | Unknown | Multi-agent (10+) |
| Data location | Centralized (Happy server) | Local | Local |
| Encryption | E2E (TweetNaCl) | WireGuard + TLS | None (localhost) |
| Deployment | CLI + mobile app + server | Single binary | Single binary |
