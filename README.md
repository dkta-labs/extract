# Extract

Web content extraction API. Converts URLs to structured, readable content — $0.001 per extraction via [x402](https://x402.org). No accounts or API keys.

**[extract.dkta.dev](https://extract.dkta.dev)**

## Usage

```bash
# Extract one page ($0.001 USDC)
curl "https://extract.dkta.dev/v1/extract?url=https://example.com&format=markdown" \
  -H "X-PAYMENT: <x402-payment-header>"
```

Successful requests return JSON:

```json
{
  "title": "Example Domain",
  "byline": null,
  "url": "https://example.com/",
  "content": "# Example Domain\n\n...",
  "length": 123,
  "word_count": 20,
  "extraction_method": "readability",
  "lang": "en"
}
```

See [x402.org](https://x402.org) for how to generate payment headers programmatically.

## API

| Method | Route | Price | Description |
|--------|-------|-------|-------------|
| GET | `/v1/extract?url=` | $0.001 | Extract one URL |
| POST | `/v1/extract/batch` | $0.005 | Extract up to 5 URLs |
| GET | `/health` | free | Health check |
| GET | `/openapi.json` | free | OpenAPI spec |
| GET | `/llms.txt` | free | LLM-readable summary |

### Single extraction

- `url` (required) — fully qualified URL to extract
- `format` (optional, default `markdown`) — `markdown` or `text`; controls the `content` field

The JSON response fields are `title`, `byline`, `url`, `content`, `length`, `word_count`, `extraction_method`, and `lang`. `title` and `byline` may be `null`.

### Batch extraction

Send a JSON body containing `urls` and an optional `format`:

```json
{
  "urls": ["https://example.com", "https://example.org"],
  "format": "markdown"
}
```

The response is `{ "results": [...] }`. Each successful item has the same fields as a single extraction. A failed URL produces an item such as `{ "url": "not-a-url", "error": "invalid url" }`; per-URL failures do not fail the whole batch. Missing or empty `urls`, or more than 5 URLs, returns HTTP 400.

## Discovery

- OpenAPI spec: `https://extract.dkta.dev/openapi.json`
- LLM summary: `https://extract.dkta.dev/llms.txt`
- x402 manifest: `https://extract.dkta.dev/.well-known/x402.json`
- Plugin manifest: `https://extract.dkta.dev/.well-known/ai-plugin.json`

## Related

- [x402](https://x402.org) — the payment protocol
