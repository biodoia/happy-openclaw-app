# happy-openclaw-app

[![fgt-sdk](https://img.shields.io/badge/fgt--sdk-v3.0-blueviolet)](https://github.com/biodoia)
[![No Tailscale](https://img.shields.io/badge/network-aigoproxy-success)](https://github.com/biodoia/aigoproxy)
[![Aligned](https://img.shields.io/badge/docs-aligned%202026-08-02-brightgreen)]()

> Repository: `happy-openclaw-app` · Go `1.22+`.

**Standard ecosistema (2026-08-01):** aigoproxy · memogo · goleciave · PebbleDB · gogatewai · mem0 · zero CGO.

## Cosa fa

Repository: `happy-openclaw-app` · Go `1.22+`.

Repository: `happy-openclaw-app` · Go `1.22+`.

## Architettura (fgt-sdk v3.0)

```
┌─────────────────────────────────────────────┐
│  1 Body — daemon systemd (background)       │
│  N Heads — TUI / Web HTMX / Chat / MCP      │
│  Bind: 127.0.0.1:<porta>  (MAI 0.0.0.0)     │
│  Pubblico: <app>.braigo.dev → aigoproxy     │
└─────────────────────────────────────────────┘
```

### Pacchetti principali

  - _(vedi albero sorgente)_

## Stack & compliance

- **Rete**: listener `127.0.0.1:<porta>` · host pubblici `*.braigo.dev` via **aigoproxy**
- **Memoria agenti**: mem0 MCP `http://127.0.0.1:12000` (`user_id=biodoia`)
- **Tailscale**: **rimosso** dall'ecosistema (2026-08-01) — vietato in docs e codice nuovo

## Avvio locale

```bash
# build (se Go)
go build -o happy-openclaw-app ./cmd/happy-openclaw-app 2>/dev/null || go build -o happy-openclaw-app .

# run su loopback
./happy-openclaw-app   # o: serve / daemon — verifica --help

# registra rotta pubblica (obbligatorio per UI web)
curl -X POST http://127.0.0.1:80/api/routes \
  -H 'Content-Type: application/json' \
  -d '{"host":"happy-openclaw-app.braigo.dev","upstream":"http://127.0.0.1:<PORTA>","auth":"none"}'
```

## Documentazione correlata

| File | Ruolo |
|------|--------|
| [`SPEC.md`](SPEC.md) | Specifica allineata |
| [`AGENTS.md`](AGENTS.md) | Regole operative agenti |
| [`QWEN.md`](QWEN.md) | Vincoli progetto per coding agent |
| [`DOCS_AUDIT_PROPOSAL.md`](DOCS_AUDIT_PROPOSAL.md) | Audit / proposta allineamento |

## Verifica

Documentazione riscritta dopo verifica del codice sorgente e inventario
**nocodaigo** (explode `--no-llm` strutturale) + **godocai scan**.

---
*docs(align): fgt-sdk v3.0 · 2026-08-02*
