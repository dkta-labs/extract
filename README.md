# Extract

Web content extraction API for AI agents. Converts public HTTP(S) URLs to structured, readable content. Pay per request with [x402](https://x402.org), or prepay $10 by card for a bearer API key. No account or subscription.

**[extract.dkta.dev](https://extract.dkta.dev)**

## Pay with x402

Extract uses x402 v2 on Base mainnet. A self-custodied EVM wallet with USDC can pay directly; Extract does not require an Extract account or API key for this path.

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

## Prepay by card

The optional $10 prepaid package buys 10,000,000 integer credit units: 10,000 single extractions, 2,000 batch requests, or any equivalent mix. Credits do not expire.

1. Open the Stripe-hosted URL returned by `GET /v1/credits/checkout`.
2. Pay by card. Stripe redirects to `/credits/success?session_id={CHECKOUT_SESSION_ID}`.
3. Copy the API key from the success page. It generates the key locally, retries the same candidate if the claim response is interrupted, and removes its temporary browser copy only after the Copy action succeeds. Extract stores only the hash, so the key cannot be recovered later.
4. Send it as a bearer token:

```bash
curl "https://extract.dkta.dev/v1/extract?url=https://example.com&format=markdown" \
  -H "Authorization: Bearer ext_live_..." \
  -H "X-Request-ID: $(uuidgen)"
```

Check the remaining balance:

```bash
curl "https://extract.dkta.dev/v1/credits/balance" \
  -H "Authorization: Bearer ext_live_..."
```

### Top up an existing key

From the landing page, choose **Top up existing**, enter the current key on Extract's private top-up page, and continue to Stripe. Extract authenticates the key and gives Stripe only a random reference bound to that key. The key and its hash never appear in the Payment Link. Every successfully paid use of that checkout link credits the same existing key.

CLI clients can create the same checkout:

```bash
TOPUP_URL=$(
  curl -fsS -X POST "https://extract.dkta.dev/v1/credits/topups" \
    -H "Authorization: Bearer $EXTRACT_API_KEY" |
    jq -r .checkout_url
)
open "$TOPUP_URL" # use xdg-open on Linux
```

After payment, Stripe redirects to the success page, which confirms that the existing key was credited. The credential does not change. Call `GET /v1/credits/balance` with the same bearer key to verify the new balance.

Keep API keys out of URLs, logs, source control, and client-side applications. Failed single extractions release their reservation and cost no credits. A batch consumes 5,000 units on its HTTP 200 response, including when individual items contain inline errors. A full refund of a completely unspent package removes only that package's units. A refund after any of its units were spent, or a dispute, suspends the key for payment review without deleting unrelated grants. Partial refunds suspend the key for review without automatically reversing the full grant; a later cumulative full-refund event resolves that partial review before applying the full-refund policy.

## API

| Method | Route | Price | Description |
|--------|-------|-------|-------------|
| GET | `/v1/extract?url=` | $0.001 | Extract one URL |
| POST | `/v1/extract/batch` | $0.005 flat | Extract 1 to 5 URLs |
| GET | `/v1/credits/checkout` | free | Get the $10 Stripe Payment Link |
| POST | `/v1/credits/topups` | free | Create a $10 checkout for the authenticated existing key |
| POST | `/v1/credits/claim` | free | Bind client-generated key material to a paid Checkout Session |
| GET | `/v1/credits/balance` | free | Read prepaid balance with bearer authentication |
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

Inputs are validated before either payment path. An x402 single extraction settles only after a successful response; a prepaid single extraction commits its reserved credits only after success. A 4xx/5xx single-extraction response is not charged. A batch is charged on its HTTP 200 response, including when individual results contain inline errors. Send a client-generated UUID as `X-Request-ID` on every request—and on the x402 paid retry—to make authorization and charging idempotent.

Direct local, private, link-local, credential-bearing, non-HTTP(S), and unresolvable targets are rejected before payment. Readability fetches pin a validated public address on every redirect hop, and the Crawl4AI worker is restricted from private and non-routable destinations at the host firewall.

## Discovery

- OpenAPI spec: `https://extract.dkta.dev/openapi.json`
- LLM summary: `https://extract.dkta.dev/llms.txt`
- x402 manifest: `https://extract.dkta.dev/.well-known/x402.json`
- Bazaar metadata is embedded in each x402 v2 `PAYMENT-REQUIRED` challenge for machine-readable discovery.
- Plugin manifest: `https://extract.dkta.dev/.well-known/ai-plugin.json`
- Sitemap: `https://extract.dkta.dev/sitemap.xml`
- Logo: `https://extract.dkta.dev/logo.svg`

## Operator configuration

Prepaid access is optional. With all four variables absent, Extract runs x402-only. Once any prepaid variable is set, all four are required or the server refuses to start.

```dotenv
CREDIT_DB_PATH=/var/lib/extract/credits.sqlite
STRIPE_PAYMENT_LINK_ID=plink_...
STRIPE_PAYMENT_LINK_URL=https://buy.stripe.com/...
STRIPE_WEBHOOK_SECRET=whsec_...
```

The reusable Stripe Payment Link must charge exactly **$10.00 USD** and redirect after payment to:

```text
https://extract.dkta.dev/credits/success?session_id={CHECKOUT_SESSION_ID}
```

Configure `https://extract.dkta.dev/v1/credits/stripe-webhook` for:

- `checkout.session.completed`
- `charge.refunded`
- `charge.dispute.created`

Before deployment, retrieve the actual Payment Link in Stripe and verify its active status, fixed amount/currency, and `after_completion.redirect.url`; a matching URL in `STRIPE_PAYMENT_LINK_URL` alone does not prove the redirect is configured. The top-up and success pages intentionally have `no-store`, `no-referrer`, and no third-party resources. The top-up page sends the bearer key only to Extract. The success page stores a new-key candidate in tab-scoped state until Copy succeeds; an existing-key top-up creates no browser copy of the key.

## Related

- [x402](https://x402.org) — the payment protocol
