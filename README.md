# Extract

Web content extraction API for AI agents. Converts public HTTP(S) URLs to structured, readable content — $0.001 per single extraction via [x402](https://x402.org). No accounts, API keys, subscriptions, or minimum spend.

**[extract.dkta.dev](https://extract.dkta.dev)**

## Usage

Extract uses x402 v2 on Base mainnet. A self-custodied EVM wallet with USDC can pay directly; Extract does not require an Extract account or API key.

Verify the service and inspect the x402 challenge without paying:

```bash
curl "https://extract.dkta.dev/health"
curl -i "https://extract.dkta.dev/v1/extract?url=https://example.com"
```

For automatic payment and retry:

```bash
npm install @x402/core @x402/evm @x402/fetch viem
```

```js
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, {
  signer: privateKeyToAccount(process.env.EVM_PRIVATE_KEY),
});
const paidFetch = wrapFetchWithPayment(globalThis.fetch, client);

const response = await paidFetch(
  "https://extract.dkta.dev/v1/extract?url=https://example.com&format=markdown",
  { headers: { "X-Request-ID": crypto.randomUUID() } },
);
console.log(await response.json());
```

To construct the payment yourself, decode `PAYMENT-REQUIRED` from the free HTTP 402 response, sign an accepted option, then retry:

```bash
curl "https://extract.dkta.dev/v1/extract?url=https://example.com&format=markdown" \
  -H "X-Request-ID: <same-client-generated-uuid>" \
  -H "PAYMENT-SIGNATURE: <x402-v2-payment-signature>"
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

See the [x402 buyer quickstart](https://docs.cdp.coinbase.com/x402/quickstart-for-buyers) for self-custodied and managed-wallet client options.

## API

| Method | Route | Price | Description |
|--------|-------|-------|-------------|
| GET | `/v1/extract?url=` | $0.001 | Extract one URL |
| POST | `/v1/extract/batch` | $0.005 flat | Extract 1 to 5 URLs |
| GET | `/health` | free | Health check |
| GET | `/openapi.json` | free | OpenAPI spec |
| GET | `/llms.txt` | free | LLM-readable summary |

### Single extraction

- `url` (required) — fully qualified public HTTP(S) URL to extract
- `format` (optional, default `markdown`) — `markdown` or `text`; controls the `content` field

The JSON response fields are `title`, `byline`, `url`, `content`, `length`, `word_count`, `extraction_method`, and `lang`. `title` and `byline` may be `null`.

### Batch extraction

Send a JSON body containing 1 to 5 `urls` and an optional `format`. The batch price is a flat $0.005 regardless of URL count:

```json
{
  "urls": ["https://example.com", "https://example.org"],
  "format": "markdown"
}
```

The response is `{ "results": [...] }`. Each successful item has the same fields as a single extraction. The entire request shape and every target URL are validated before payment; invalid input returns HTTP 400. The batch returns HTTP 200 and settles the flat payment even when upstream or extraction failures are included inline, such as `{ "url": "https://example.com/missing", "error": "upstream returned 404" }`.

## Payment and failures

Inputs are validated before the x402 challenge. A single extraction settles only after a successful response; a 4xx/5xx single-extraction response is not settled. A batch settles on its HTTP 200 response, including when individual results contain inline errors. Send a client-generated UUID as `X-Request-ID` on the initial request and paid retry to correlate authorization, extraction, and settlement.

Direct local, private, link-local, credential-bearing, non-HTTP(S), and unresolvable targets are rejected before payment. Readability fetches pin a validated public address on every redirect hop, and the Crawl4AI worker is restricted from private and non-routable destinations at the host firewall.

## Discovery

- OpenAPI spec: `https://extract.dkta.dev/openapi.json`
- LLM summary: `https://extract.dkta.dev/llms.txt`
- x402 manifest: `https://extract.dkta.dev/.well-known/x402.json`
- Bazaar metadata is embedded in each x402 v2 `PAYMENT-REQUIRED` challenge for machine-readable discovery.
- Plugin manifest: `https://extract.dkta.dev/.well-known/ai-plugin.json`
- Sitemap: `https://extract.dkta.dev/sitemap.xml`
- Logo: `https://extract.dkta.dev/logo.svg`

## Related

- [x402](https://x402.org) — the payment protocol
