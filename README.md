# Extract

Web content extraction API with MCP support. Converts any URL to clean, readable markdown — $0.001 per extraction via [x402](https://x402.org). No accounts, no API keys.

**[extract.dkta.dev](https://extract.dkta.dev)**

## Usage

```bash
# Extract a page ($0.001 USDC)
curl "https://extract.dkta.dev/v1/extract?url=https://example.com" \
  -H "X-Payment: <x402-payment-header>"
```

Returns clean markdown stripped of navigation, ads, and boilerplate — just the content.

See [x402.org](https://x402.org) for how to generate payment headers programmatically.

## API

| Method | Route | Price | Description |
|--------|-------|-------|-------------|
| GET | `/v1/extract?url=` | $0.001 | Extract URL to markdown |
| GET | `/health` | free | Health check |
| GET | `/openapi.json` | free | OpenAPI spec |
| GET | `/llms.txt` | free | LLM-readable summary |

**Parameters:**
- `url` (required) — the URL to extract
- `format` (optional, default `markdown`) — output format

## MCP Support

Extract is available as an MCP tool. Point your MCP client at `https://extract.dkta.dev` to use it directly from Claude, Cursor, or any MCP-compatible agent host.

## Discovery

- OpenAPI spec: `https://extract.dkta.dev/openapi.json`
- LLM summary: `https://extract.dkta.dev/llms.txt`
- x402 manifest: `https://extract.dkta.dev/.well-known/x402.json`
- Plugin manifest: `https://extract.dkta.dev/.well-known/ai-plugin.json`

## Related

- [engram](https://github.com/dkta0/engram) — shared memory API, same x402 pattern
- [x402](https://x402.org) — the payment protocol
