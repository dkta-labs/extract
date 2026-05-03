import express from 'express'
import { paymentMiddleware } from 'x402-express'
import { createCdpAuthHeaders } from '@coinbase/x402'
import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import fetch from 'node-fetch'

const app = express()
app.set('trust proxy', true) // Cloudflare + Caddy sit in front
const PORT = process.env.PORT || 3721
const PAYMENT_ADDRESS = process.env.PAYMENT_ADDRESS || '0x1A7501Da9b9B365910F8C57EE19Bec7C620d0468'
const NETWORK = process.env.NETWORK || 'base'

// x402 payment gate — $0.001 per extraction
app.use(paymentMiddleware(
  PAYMENT_ADDRESS,
  {
    '/v1/extract': {
      price: '$0.001',
      network: NETWORK,
      config: { description: 'Extract clean markdown from any URL' },
    },
  },
  {
    url: 'https://api.cdp.coinbase.com/platform/v2/x402',
    createAuthHeaders: createCdpAuthHeaders(
      process.env.CDP_API_KEY_ID,
      process.env.CDP_API_KEY_SECRET
    )
  }
))

app.get('/v1/extract', async (req, res) => {
  const { url } = req.query
  if (!url) return res.status(400).json({ error: 'url query param required' })

  let targetUrl
  try {
    targetUrl = new URL(url)
  } catch {
    return res.status(400).json({ error: 'invalid url' })
  }

  try {
    const response = await fetch(targetUrl.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; extract-api/1.0)' },
      redirect: 'follow',
      timeout: 10000,
    })

    if (!response.ok) {
      return res.status(502).json({ error: `upstream returned ${response.status}` })
    }

    const html = await response.text()
    const dom = new JSDOM(html, { url: targetUrl.toString() })
    const reader = new Readability(dom.window.document)
    const article = reader.parse()

    if (!article) {
      return res.status(422).json({ error: 'could not extract readable content from url' })
    }

    // Convert HTML content to plain text (basic)
    const textDom = new JSDOM(article.content)
    const text = textDom.window.document.body.textContent.replace(/\s+/g, ' ').trim()

    return res.json({
      title: article.title,
      byline: article.byline,
      url: targetUrl.toString(),
      text,
      length: text.length,
    })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
})

// ─── OpenAPI spec ────────────────────────────────────────────────────────────
const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'extract.dkta.dev',
    version: '1.0.0',
    description:
      'Clean content extraction for AI agents. Every request to `GET /v1/extract` ' +
      'requires a micropayment of **$0.001 USDC** on Base mainnet via the ' +
      '[x402 protocol](https://x402.org). Send the signed payment in the ' +
      '`X-PAYMENT` request header.',
  },
  servers: [{ url: 'https://extract.dkta.dev', description: 'Production' }],
  paths: {
    '/v1/extract': {
      get: {
        summary: 'Extract readable content from a URL',
        description:
          'Fetches the target URL, strips boilerplate with Mozilla Readability, ' +
          'and returns structured plain-text content. Requires an x402 micropayment ' +
          '($0.001 USDC on Base mainnet) in the `X-PAYMENT` header.',
        operationId: 'extractUrl',
        parameters: [
          {
            name: 'url',
            in: 'query',
            required: true,
            description: 'Fully-qualified URL to extract content from',
            schema: { type: 'string', format: 'uri', example: 'https://example.com/article' },
          },
        ],
        security: [{ x402Payment: [] }],
        responses: {
          '200': {
            description: 'Extracted content',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    title:   { type: 'string', description: 'Article title', nullable: true },
                    byline:  { type: 'string', description: 'Author / byline', nullable: true },
                    content: { type: 'string', description: 'Readable HTML content returned by Readability', nullable: true },
                    length:  { type: 'integer', description: 'Character length of the extracted plain text' },
                    excerpt: { type: 'string', description: 'Short excerpt / lead paragraph', nullable: true },
                  },
                  required: ['length'],
                },
                example: {
                  title: 'Hello World',
                  byline: 'Jane Doe',
                  content: '<p>Article body…</p>',
                  length: 4821,
                  excerpt: 'A short preview of the article…',
                },
              },
            },
          },
          '400': {
            description: 'Bad request — missing or invalid `url` parameter',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '402': {
            description:
              'Payment required. The server returns x402-compliant payment details. ' +
              'Re-submit the request with a valid `X-PAYMENT` header containing the ' +
              'signed USDC transfer.',
            headers: {
              'X-Payment-Response': {
                description: 'x402 payment challenge details (JSON-encoded)',
                schema: { type: 'string' },
              },
            },
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error:   { type: 'string', example: 'Payment required' },
                    accepts: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          scheme:  { type: 'string', example: 'exact' },
                          network: { type: 'string', example: 'base' },
                          maxAmountRequired: { type: 'string', example: '1000' },
                          resource: { type: 'string', example: 'https://extract.dkta.dev/v1/extract' },
                          description: { type: 'string' },
                          mimeType: { type: 'string', example: 'application/json' },
                          payTo: { type: 'string', example: '0x9C924E0b95FBE2Fe69D6ecDb434AEBFa15E236b2' },
                          requiredDeadlineSeconds: { type: 'integer', example: 300 },
                          asset: { type: 'string', example: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
                          extra: { type: 'object' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '422': {
            description: 'Content could not be extracted from the target URL',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '502': {
            description: 'Upstream URL returned a non-2xx response',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '500': {
            description: 'Internal server error',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    '/openapi.json': {
      get: {
        summary: 'OpenAPI specification',
        operationId: 'getOpenApiSpec',
        responses: {
          '200': { description: 'OpenAPI 3.0 JSON spec' },
        },
      },
    },
    '/docs': {
      get: {
        summary: 'Swagger UI documentation',
        operationId: 'getDocs',
        responses: {
          '200': { description: 'Interactive Swagger UI HTML page' },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      x402Payment: {
        type: 'apiKey',
        in: 'header',
        name: 'X-PAYMENT',
        description:
          'x402 signed payment header. Obtain via an x402-compatible wallet client ' +
          '(e.g. `x402-fetch`) by signing a USDC transfer of $0.001 on Base mainnet ' +
          'payable to `0x9C924E0b95FBE2Fe69D6ecDb434AEBFa15E236b2`.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
        },
        required: ['error'],
      },
    },
  },
}

app.get('/openapi.json', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.json(openApiSpec)
})

app.get('/docs', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>extract.dkta.dev — API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; background: #0a0a0a; }
    .swagger-ui .topbar { background: #141414; border-bottom: 1px solid #222; }
    .swagger-ui .topbar .download-url-wrapper { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: 'StandaloneLayout',
      deepLinking: true,
    })
  </script>
</body>
</html>`)
})

app.get('/health', (_req, res) => res.json({ ok: true }))

app.get('/', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>extract.dkta.dev — Clean content extraction for AI agents</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #e5e5e5; min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2rem; }
    .container { max-width: 680px; width: 100%; }
    h1 { font-size: 1.8rem; font-weight: 700; margin-bottom: 0.5rem; color: #fff; }
    .sub { color: #888; margin-bottom: 2.5rem; font-size: 1rem; }
    .card { background: #141414; border: 1px solid #222; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
    .card h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; color: #666; margin-bottom: 1rem; }
    pre { background: #0d0d0d; border: 1px solid #1e1e1e; border-radius: 8px; padding: 1rem; overflow-x: auto; font-size: 0.85rem; color: #a3e635; line-height: 1.6; }
    .price { display: inline-block; background: #1a2e1a; color: #4ade80; border: 1px solid #166534; border-radius: 6px; padding: 0.25rem 0.75rem; font-size: 0.85rem; font-weight: 600; margin-bottom: 1rem; }
    .footer { color: #444; font-size: 0.8rem; margin-top: 2rem; text-align: center; }
    a { color: #60a5fa; text-decoration: none; }
  </style>
</head>
<body>
  <div class="container">
    <h1>extract.dkta.dev</h1>
    <p class="sub">Clean content extraction for AI agents. Pay per call with USDC on Base.</p>

    <div class="card">
      <h2>Endpoint</h2>
      <span class="price">$0.001 / request</span>
      <pre>GET /v1/extract?url=https://example.com/article</pre>
    </div>

    <div class="card">
      <h2>Response</h2>
      <pre>{
  "title": "Article Title",
  "byline": "Author Name",
  "url": "https://...",
  "text": "Clean extracted text...",
  "length": 4821
}</pre>
    </div>

    <div class="card">
      <h2>Usage (x402-fetch)</h2>
      <pre>import { wrapWithPaymentClientFetch } from 'x402-fetch'

const fetch = wrapWithPaymentClientFetch(globalThis.fetch, walletClient)
const res = await fetch('https://extract.dkta.dev/v1/extract?url=...')
const { title, text } = await res.json()</pre>
    </div>

    <p class="footer">Powered by <a href="https://x402.org">x402</a> · USDC on Base · <a href="/health">/health</a></p>
  </div>
</body>
</html>`)
})

const server = app.listen(PORT, () => {
  console.log(`extract API running on :${PORT} (network: ${NETWORK}, payTo: ${PAYMENT_ADDRESS})`)
})

// Keep event loop alive under systemd (no TTY)
setInterval(() => {}, 1 << 30)

process.on('SIGTERM', () => { server.close(() => process.exit(0)) })
process.on('SIGINT', () => { server.close(() => process.exit(0)) })
