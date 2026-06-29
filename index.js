import express from 'express'
import { paymentMiddleware } from 'x402-express'
import { createCdpAuthHeaders } from '@coinbase/x402'
import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'

const LOG_PATH = '/opt/extract/logs/requests.jsonl'

// Log rotation: if log file exceeds 10MB, rotate it
try {
  const stat = fs.statSync(LOG_PATH)
  if (stat.size > 10 * 1024 * 1024) {
    fs.renameSync(LOG_PATH, LOG_PATH + '.1')
    console.log('Log rotated: requests.jsonl -> requests.jsonl.1')
  }
} catch (_) { /* file may not exist yet */ }

function logRequest(entry) {
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n')
}

const UMAMI_URL = 'http://localhost:3725/api/send'
const UMAMI_SITE_ID = '5eeb856b-0ecd-4acd-9208-8fb522b41bf7'
async function umamiEvent(name, data = {}) {
  try {
    await fetch(UMAMI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payload: {
          website: UMAMI_SITE_ID,
          hostname: 'extract.dkta.dev',
          language: 'en',
          url: '/v1/extract',
          name,
          data,
        },
        type: 'event',
      }),
    })
  } catch (_) { /* never block on analytics */ }
}

const app = express()
app.set('trust proxy', true) // Cloudflare + Caddy sit in front
const PORT = process.env.PORT || 3721
const PAYMENT_ADDRESS = process.env.PAYMENT_ADDRESS || '0x1A7501Da9b9B365910F8C57EE19Bec7C620d0468'
const NETWORK = process.env.NETWORK || 'base'

// CORS headers required so browser-based agents can read 402 challenges and payment headers.
// Scoped to /v1/extract and discovery endpoints only — not applied globally.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-payment, payment-signature, x-payment-signature, authorization',
  'Access-Control-Expose-Headers': 'x-payment-response, www-authenticate',
}

function applyCors(res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v))
}

// Handle CORS preflight BEFORE payment middleware — OPTIONS must return 200, not 402
app.options('/v1/extract', (req, res) => {
  applyCors(res)
  res.sendStatus(200)
})
app.options('/v1/extract/batch', (req, res) => {
  applyCors(res)
  res.sendStatus(200)
})

// Scoped CORS — only /v1/extract routes and well-known discovery routes
app.use(['/v1/extract', '/v1/extract/batch', '/.well-known/x402', '/.well-known/x402.json', '/openapi.json'], (req, res, next) => {
  applyCors(res)
  next()
})

// Ensure 402 responses are never cached regardless of how paymentMiddleware sends them.
// Hook writeHead so this fires even if x402-express uses res.send/res.end rather than res.json.
app.use(['/v1/extract', '/v1/extract/batch'], (req, res, next) => {
  const _writeHead = res.writeHead.bind(res)
  res.writeHead = function (statusCode, ...args) {
    if (statusCode === 402) {
      res.setHeader('Cache-Control', 'private, no-store')
    }
    return _writeHead(statusCode, ...args)
  }
  next()
})

// x402 payment gate — $0.001 per extraction, $0.005 per batch
app.use(paymentMiddleware(
  PAYMENT_ADDRESS,
  {
    'GET /v1/extract': {
      price: '$0.001',
      network: NETWORK,
      config: {
        description: 'Extract clean markdown from any URL',
        inputSchema: {
          properties: {
            url: { type: 'string', description: 'Fully-qualified URL to extract content from' },
            format: { type: 'string', enum: ['markdown', 'text'], description: 'Output format' },
          },
          required: ['url'],
        },
        outputSchema: {
          example: { title: 'Article Title', byline: 'Author', content: '# Markdown...', length: 4821, word_count: 800, extraction_method: 'crawl4ai', lang: 'en' },
          schema: {
            properties: {
              title: { type: 'string' },
              byline: { type: 'string' },
              url: { type: 'string' },
              content: { type: 'string' },
              length: { type: 'number' },
              word_count: { type: 'number' },
              extraction_method: { type: 'string', enum: ['crawl4ai', 'readability'] },
              lang: { type: 'string' },
            },
          },
        },
      },
    },
    'POST /v1/extract/batch': {
      price: '$0.005',
      network: NETWORK,
      config: {
        description: 'Batch extract clean markdown from up to 5 URLs',
        inputSchema: {
          properties: {
            urls: { type: 'array', items: { type: 'string' }, description: 'Array of URLs to extract (max 5)' },
            format: { type: 'string', enum: ['markdown', 'text'], description: 'Output format' },
          },
          required: ['urls'],
        },
      },
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

// Simple language detection: check first 100 chars for CJK codepoints, default to 'en'
function detectLang(text) {
  const sample = text ? text.slice(0, 100) : ''
  if (/[\u3000-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/.test(sample)) return 'zh'
  return 'en'
}

app.get('/v1/extract', async (req, res) => {
  const { url, format = 'markdown' } = req.query
  const ts = new Date().toISOString()
  const ip = req.ip
  const start = Date.now()
  if (!url) {
    logRequest({ ts, ip, event: 'bad_request', reason: 'missing_url' })
    umamiEvent('extract-request', { status: 400, reason: 'missing_url', paid: false })
    return res.status(400).json({ error: 'url query param required' })
  }

  let targetUrl
  try {
    targetUrl = new URL(url)
  } catch {
    umamiEvent('extract-request', { status: 400, reason: 'invalid_url', paid: false })
    return res.status(400).json({ error: 'invalid url' })
  }

  try {
    // Try crawl4ai first
    let markdownContent = null
    let title = null
    let byline = null
    let extraction_method = 'readability'

    try {
      const crawlRes = await fetch('http://localhost:11235/md', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl.toString(), f: 'fit' }),
        timeout: 15000,
      })
      if (crawlRes.ok) {
        const crawlData = await crawlRes.json()
        if (crawlData.markdown && crawlData.markdown.trim()) {
          markdownContent = crawlData.markdown.trim()
          extraction_method = 'crawl4ai'
        }
      }
    } catch (_) { /* crawl4ai unavailable, fall through to Readability */ }

    // Fall back to Readability if crawl4ai returned empty or errored
    let plainText = null
    if (!markdownContent) {
      extraction_method = 'readability'
      const response = await fetch(targetUrl.toString(), {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; extract-api/1.0)' },
        redirect: 'follow',
        timeout: 10000,
      })

      if (!response.ok) {
        umamiEvent('extract-request', { status: 502, reason: 'upstream_error', upstream_status: response.status, paid: true })
        return res.status(502).json({ error: `upstream returned ${response.status}` })
      }

      const html = await response.text()
      const dom = new JSDOM(html, { url: targetUrl.toString() })
      const reader = new Readability(dom.window.document)
      const article = reader.parse()

      if (!article) {
        umamiEvent('extract-request', { status: 422, reason: 'not_readable', paid: true })
        return res.status(422).json({ error: 'could not extract readable content from url' })
      }

      title = article.title
      byline = article.byline

      const textDom = new JSDOM(article.content)
      plainText = textDom.window.document.body.textContent.replace(/\s+/g, ' ').trim()
    }

    // Determine content based on format param
    const content = (format === 'text')
      ? (plainText || markdownContent.replace(/[#*`_~\[\]]/g, '').replace(/\s+/g, ' ').trim())
      : (markdownContent || plainText)

    const word_count = content ? content.trim().split(/\s+/).filter(Boolean).length : 0
    const lang = detectLang(content)
    const result = {
      title,
      byline,
      url: targetUrl.toString(),
      content,
      length: content.length,
      word_count,
      extraction_method,
      lang,
    }
    const duration_ms = Date.now() - start
    logRequest({ ts, ip, event: 'success', url: targetUrl.toString(), length: content.length, format, paid: true })
    umamiEvent('extract-request', { status: 200, paid: true, format, length: content.length, duration_ms })
    res.setHeader('X-RateLimit-Limit', '20')
    res.setHeader('X-RateLimit-Remaining', '19')
    return res.json(result)
  } catch (err) {
    umamiEvent('extract-request', { status: 500, reason: err.message, paid: true })
    return res.status(500).json({ error: err.message })
  }
})

// ─── Batch extraction endpoint ────────────────────────────────────────────────
app.post('/v1/extract/batch', express.json(), async (req, res) => {
  const ts = new Date().toISOString()
  const ip = req.ip
  const start = Date.now()
  const { urls, format = 'markdown' } = req.body || {}

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    logRequest({ ts, ip, event: 'bad_request', reason: 'missing_urls', endpoint: 'batch' })
    return res.status(400).json({ error: 'urls array required' })
  }
  if (urls.length > 5) {
    logRequest({ ts, ip, event: 'bad_request', reason: 'too_many_urls', count: urls.length, endpoint: 'batch' })
    return res.status(400).json({ error: 'maximum 5 URLs per batch request' })
  }

  // Helper to extract a single URL (reuses same crawl4ai → Readability logic)
  async function extractOne(urlStr) {
    let targetUrl
    try {
      targetUrl = new URL(urlStr)
    } catch {
      return { url: urlStr, error: 'invalid url' }
    }
    try {
      let markdownContent = null
      let title = null
      let byline = null
      let extraction_method = 'readability'

      try {
        const crawlRes = await fetch('http://localhost:11235/md', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: targetUrl.toString(), f: 'fit' }),
          timeout: 15000,
        })
        if (crawlRes.ok) {
          const crawlData = await crawlRes.json()
          if (crawlData.markdown && crawlData.markdown.trim()) {
            markdownContent = crawlData.markdown.trim()
            extraction_method = 'crawl4ai'
          }
        }
      } catch (_) { /* crawl4ai unavailable, fall through to Readability */ }

      let plainText = null
      if (!markdownContent) {
        extraction_method = 'readability'
        const response = await fetch(targetUrl.toString(), {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; extract-api/1.0)' },
          redirect: 'follow',
          timeout: 10000,
        })
        if (!response.ok) {
          return { url: targetUrl.toString(), error: `upstream returned ${response.status}` }
        }
        const html = await response.text()
        const dom = new JSDOM(html, { url: targetUrl.toString() })
        const reader = new Readability(dom.window.document)
        const article = reader.parse()
        if (!article) {
          return { url: targetUrl.toString(), error: 'could not extract readable content from url' }
        }
        title = article.title
        byline = article.byline
        const textDom = new JSDOM(article.content)
        plainText = textDom.window.document.body.textContent.replace(/\s+/g, ' ').trim()
      }

      const content = (format === 'text')
        ? (plainText || markdownContent.replace(/[#*`_~\[\]]/g, '').replace(/\s+/g, ' ').trim())
        : (markdownContent || plainText)

      const word_count = content ? content.trim().split(/\s+/).filter(Boolean).length : 0
      const lang = detectLang(content)
      return {
        title,
        byline,
        url: targetUrl.toString(),
        content,
        length: content.length,
        word_count,
        extraction_method,
        lang,
      }
    } catch (err) {
      return { url: urlStr, error: err.message }
    }
  }

  try {
    const results = await Promise.all(urls.map(u => extractOne(u)))
    const duration_ms = Date.now() - start
    logRequest({ ts, ip, event: 'success', endpoint: 'batch', count: urls.length, format, paid: true, duration_ms })
    umamiEvent('extract-batch', { status: 200, paid: true, format, count: urls.length, duration_ms })
    res.setHeader('X-RateLimit-Limit', '20')
    res.setHeader('X-RateLimit-Remaining', '19')
    return res.json({ results })
  } catch (err) {
    umamiEvent('extract-batch', { status: 500, reason: err.message, paid: true })
    return res.status(500).json({ error: err.message })
  }
})

// ─── OpenAPI spec ────────────────────────────────────────────────────────────
const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'extract.dkta.dev',
    version: '1.1.0',
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
          {
            name: 'format',
            in: 'query',
            required: false,
            description: 'Output format: markdown (default) or text',
            schema: { type: 'string', enum: ['markdown', 'text'], default: 'markdown' },
          },
        ],
        security: [{ x402Payment: [] }],
        responses: {
          '200': {
            description: 'Extracted content',
            headers: {
              'X-RateLimit-Limit': { description: 'Request limit per window', schema: { type: 'integer', example: 20 } },
              'X-RateLimit-Remaining': { description: 'Requests remaining in window', schema: { type: 'integer', example: 19 } },
            },
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    title:            { type: 'string', description: 'Article title', nullable: true },
                    byline:           { type: 'string', description: 'Author / byline', nullable: true },
                    url:              { type: 'string', description: 'Canonical URL of the extracted page' },
                    content:          { type: 'string', description: 'Markdown or plain text depending on format param', nullable: true },
                    length:           { type: 'integer', description: 'Character length of the extracted content' },
                    word_count:       { type: 'integer', description: 'Approximate word count of extracted content' },
                    extraction_method: { type: 'string', enum: ['crawl4ai', 'readability'], description: 'Backend used for extraction' },
                    lang:             { type: 'string', description: 'Detected language (e.g. "en", "zh")' },
                  },
                  required: ['length', 'word_count', 'extraction_method', 'lang'],
                },
                example: {
                  title: 'Hello World',
                  byline: 'Jane Doe',
                  url: 'https://example.com/article',
                  content: '# Hello World\n\nArticle body…',
                  length: 4821,
                  word_count: 800,
                  extraction_method: 'crawl4ai',
                  lang: 'en',
                },
              },
            },
          },
          '400': {
            description: 'Bad request — missing or invalid `url` parameter',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
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
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          '502': {
            description: 'Upstream URL returned a non-2xx response',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          '500': {
            description: 'Internal server error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },
    '/v1/extract/batch': {
      post: {
        summary: 'Batch extract readable content from multiple URLs',
        description:
          'Accepts up to 5 URLs and returns an array of extracted results. ' +
          'Per-URL errors are included inline — the overall request still returns 200. ' +
          'Requires an x402 micropayment of **$0.005 USDC** on Base mainnet.',
        operationId: 'extractBatch',
        security: [{ x402Payment: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  urls:   { type: 'array', items: { type: 'string', format: 'uri' }, maxItems: 5, description: 'Array of URLs to extract (max 5)' },
                  format: { type: 'string', enum: ['markdown', 'text'], default: 'markdown', description: 'Output format for all URLs' },
                },
                required: ['urls'],
              },
              example: {
                urls: ['https://example.com/article1', 'https://example.com/article2'],
                format: 'markdown',
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Array of extraction results (may include per-URL errors)',
            headers: {
              'X-RateLimit-Limit': { description: 'Request limit per window', schema: { type: 'integer', example: 20 } },
              'X-RateLimit-Remaining': { description: 'Requests remaining in window', schema: { type: 'integer', example: 19 } },
            },
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    results: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          title:             { type: 'string', nullable: true },
                          byline:            { type: 'string', nullable: true },
                          url:               { type: 'string' },
                          content:           { type: 'string', nullable: true },
                          length:            { type: 'integer' },
                          word_count:        { type: 'integer' },
                          extraction_method: { type: 'string', enum: ['crawl4ai', 'readability'] },
                          lang:              { type: 'string' },
                          error:             { type: 'string', description: 'Set only when this URL failed', nullable: true },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Bad request — missing urls or too many URLs (max 5)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          '402': {
            description: 'Payment required ($0.005 USDC on Base mainnet)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          '500': {
            description: 'Internal server error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
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
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='4'%20fill='%230a0a0a'/%3E%3Crect%20x='7'%20y='13'%20width='12'%20height='12'%20rx='1.5'%20stroke='%23a3e635'%20stroke-width='2'%20fill='none'/%3E%3Cpath%20d='M17%207%20L25%207%20L25%2015'%20stroke='%23a3e635'%20stroke-width='2'%20fill='none'%20stroke-linecap='round'%20stroke-linejoin='round'/%3E%3Cline%20x1='25'%20y1='7'%20x2='15'%20y2='17'%20stroke='%23a3e635'%20stroke-width='2'%20stroke-linecap='round'/%3E%3C/svg%3E">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>extract.dkta.dev — API Docs</title>
  <script defer src="https://analytics.dkta.dev/script.js" data-website-id="5eeb856b-0ecd-4acd-9208-8fb522b41bf7"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    :root {
      --bg-base:      #0a0a0a;
      --bg-surface:   #111111;
      --bg-raised:    #161616;
      --bg-code:      #0d0d0d;
      --border:       #1e1e1e;
      --border-mid:   #2a2a2a;
      --text-primary: #f0f0f0;
      --text-secondary: #888888;
      --text-tertiary: #555555;
      --accent:       #1a6bff;
      --accent-hover: #3d84ff;
      --accent-muted: rgba(26, 107, 255, 0.12);
      --green:        #00c97a;
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
      --radius-sm: 6px;
      --radius-md: 10px;
    }
    body { margin: 0; background: var(--bg-base); font-family: var(--font-sans); }

    /* Hide default topbar */
    .swagger-ui .topbar { display: none; }

    /* Page background */
    .swagger-ui { background: var(--bg-base); color: var(--text-primary); }

    /* Scheme section */
    .swagger-ui .scheme-container {
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border);
      box-shadow: none;
    }

    /* Operation blocks */
    .swagger-ui .opblock {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
    }
    .swagger-ui .opblock.opblock-get .opblock-summary {
      border-color: var(--accent);
    }
    .swagger-ui .opblock.opblock-get .opblock-summary-method {
      background: var(--accent);
      font-family: var(--font-mono);
    }

    /* Inputs */
    .swagger-ui input[type=text], .swagger-ui textarea {
      background: var(--bg-code);
      border: 1px solid var(--border-mid);
      color: var(--text-primary);
      font-family: var(--font-mono);
      border-radius: var(--radius-sm);
    }

    /* Execute button */
    .swagger-ui .btn.execute {
      background: var(--accent);
      border-color: var(--accent);
      font-family: var(--font-mono);
      font-size: 13px;
      border-radius: var(--radius-sm);
    }
    .swagger-ui .btn.execute:hover { background: var(--accent-hover); }

    /* Response body */
    .swagger-ui .highlight-code, .swagger-ui .microlight {
      background: var(--bg-code);
      border-radius: var(--radius-md);
      font-family: var(--font-mono);
      font-size: 12px;
    }

    /* Models section */
    .swagger-ui section.models {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
    }
    .swagger-ui .model-box { background: var(--bg-raised); }

    /* Typography */
    .swagger-ui .info .title,
    .swagger-ui .info h1,
    .swagger-ui .info h2 {
      font-family: var(--font-sans);
      color: var(--text-primary);
      letter-spacing: -0.025em;
    }
    .swagger-ui .info p { color: var(--text-secondary); }
    .swagger-ui label,
    .swagger-ui .parameter__name,
    .swagger-ui .parameter__type {
      font-family: var(--font-mono);
      color: var(--text-secondary);
    }

    /* Response code */
    .swagger-ui .responses-table .response-col_status {
      font-family: var(--font-mono);
      color: var(--green);
    }
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
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2032%2032'%3E%3Crect%20width='32'%20height='32'%20rx='4'%20fill='%230a0a0a'/%3E%3Crect%20x='7'%20y='13'%20width='12'%20height='12'%20rx='1.5'%20stroke='%23a3e635'%20stroke-width='2'%20fill='none'/%3E%3Cpath%20d='M17%207%20L25%207%20L25%2015'%20stroke='%23a3e635'%20stroke-width='2'%20fill='none'%20stroke-linecap='round'%20stroke-linejoin='round'/%3E%3Cline%20x1='25'%20y1='7'%20x2='15'%20y2='17'%20stroke='%23a3e635'%20stroke-width='2'%20stroke-linecap='round'/%3E%3C/svg%3E">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>extract.dkta.dev — Clean content for AI agents</title>
  <script defer src="https://analytics.dkta.dev/script.js" data-website-id="5eeb856b-0ecd-4acd-9208-8fb522b41bf7"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    /* ─── Design tokens ──────────────────────────────────────────────── */
    :root {
      --bg-base:      #0a0a0a;
      --bg-surface:   #111111;
      --bg-raised:    #161616;
      --bg-code:      #0d0d0d;
      --border:       #1e1e1e;
      --border-mid:   #2a2a2a;
      --text-primary: #f0f0f0;
      --text-secondary: #888888;
      --text-tertiary: #555555;
      --accent:       #1a6bff;
      --accent-hover: #3d84ff;
      --accent-muted: rgba(26, 107, 255, 0.12);
      --accent-ring:  rgba(26, 107, 255, 0.35);
      --green:        #00c97a;
      --green-muted:  rgba(0, 201, 122, 0.1);
      --amber:        #f5a623;

      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      --font-mono: 'JetBrains Mono', 'Fira Code', monospace;

      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 16px;

      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 20px;
      --space-6: 24px;
      --space-8: 32px;
      --space-10: 40px;
      --space-12: 48px;
      --space-16: 64px;
      --space-20: 80px;
      --space-24: 96px;

      --max-width: 1100px;
      --content-width: 720px;
    }

    /* ─── Reset ──────────────────────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      font-family: var(--font-sans);
      font-size: 15px;
      line-height: 1.6;
      background: var(--bg-base);
      color: var(--text-primary);
      -webkit-font-smoothing: antialiased;
    }
    a { color: inherit; text-decoration: none; }
    code, pre { font-family: var(--font-mono); }

    /* ─── Layout helpers ─────────────────────────────────────────────── */
    .container {
      max-width: var(--max-width);
      margin: 0 auto;
      padding: 0 var(--space-6);
    }
    .container--narrow {
      max-width: var(--content-width);
      margin: 0 auto;
      padding: 0 var(--space-6);
    }

    /* ─── NAV ────────────────────────────────────────────────────────── */
    nav {
      position: sticky;
      top: 0;
      z-index: 100;
      border-bottom: 1px solid var(--border);
      background: rgba(10, 10, 10, 0.85);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    .nav-inner {
      display: flex;
      align-items: center;
      gap: var(--space-6);
      height: 56px;
      max-width: var(--max-width);
      margin: 0 auto;
      padding: 0 var(--space-6);
    }
    .nav-logo {
      font-family: var(--font-mono);
      font-size: 14px;
      font-weight: 500;
      color: var(--text-primary);
      letter-spacing: -0.02em;
      flex-shrink: 0;
    }
    .nav-logo span { color: var(--accent); }
    .nav-links {
      display: flex;
      align-items: center;
      gap: var(--space-5);
      margin-left: auto;
    }
    .nav-links a {
      font-size: 13px;
      color: var(--text-secondary);
      transition: color 0.15s;
    }
    .nav-links a:hover { color: var(--text-primary); }
    .nav-cta {
      font-size: 13px;
      font-weight: 500;
      color: var(--accent) !important;
      border: 1px solid rgba(26, 107, 255, 0.4);
      padding: 6px 14px;
      border-radius: var(--radius-sm);
      transition: background 0.15s, border-color 0.15s !important;
    }
    .nav-cta:hover {
      background: var(--accent-muted);
      border-color: var(--accent) !important;
    }

    /* ─── HERO ───────────────────────────────────────────────────────── */
    .hero {
      padding: var(--space-24) 0 var(--space-20);
      text-align: center;
      position: relative;
      overflow: hidden;
    }
    .hero::before {
      content: '';
      position: absolute;
      top: -120px;
      left: 50%;
      transform: translateX(-50%);
      width: 600px;
      height: 600px;
      background: radial-gradient(ellipse at center, rgba(26, 107, 255, 0.07) 0%, transparent 70%);
      pointer-events: none;
    }
    .hero-badge {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--accent);
      background: var(--accent-muted);
      border: 1px solid rgba(26, 107, 255, 0.25);
      padding: 4px 12px;
      border-radius: 100px;
      margin-bottom: var(--space-6);
      letter-spacing: 0.03em;
    }
    .hero-badge::before {
      content: '';
      width: 6px;
      height: 6px;
      background: var(--accent);
      border-radius: 50%;
    }
    h1 {
      font-size: clamp(32px, 5vw, 52px);
      font-weight: 600;
      letter-spacing: -0.03em;
      line-height: 1.1;
      color: var(--text-primary);
      margin-bottom: var(--space-5);
    }
    h1 em {
      font-style: normal;
      color: var(--accent);
    }
    .hero-sub {
      font-size: 17px;
      color: var(--text-secondary);
      max-width: 480px;
      margin: 0 auto var(--space-10);
      line-height: 1.55;
    }
    .price-pill {
      display: inline-block;
      font-family: var(--font-mono);
      font-size: 12px;
      font-weight: 500;
      color: var(--green);
      background: var(--green-muted);
      border: 1px solid rgba(0, 201, 122, 0.2);
      padding: 3px 10px;
      border-radius: 100px;
    }

    /* ─── CODE BLOCK (hero) ──────────────────────────────────────────── */
    .hero-code-wrap {
      max-width: 640px;
      margin: 0 auto;
      text-align: left;
    }
    .code-panel {
      background: var(--bg-code);
      border: 1px solid var(--border-mid);
      border-radius: var(--radius-lg);
      overflow: hidden;
    }
    .code-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--space-3) var(--space-4);
      border-bottom: 1px solid var(--border);
      background: var(--bg-surface);
    }
    .code-tabs {
      display: flex;
      gap: 2px;
    }
    .code-tab {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 4px 10px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      color: var(--text-secondary);
      transition: background 0.1s, color 0.1s;
      border: none;
      background: transparent;
    }
    .code-tab.active {
      background: var(--accent-muted);
      color: var(--accent);
    }
    .copy-btn {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-tertiary);
      background: transparent;
      border: 1px solid var(--border);
      padding: 3px 8px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
    }
    .copy-btn:hover {
      color: var(--text-secondary);
      border-color: var(--border-mid);
    }
    .code-body {
      padding: var(--space-5) var(--space-6);
      overflow-x: auto;
    }
    .code-body pre {
      font-size: 13px;
      line-height: 1.65;
      color: #c9d1d9;
      white-space: pre;
    }
    /* syntax colors */
    .t-comment { color: #555e6d; }
    .t-keyword  { color: #ff7b72; }
    .t-string   { color: #a5d6ff; }
    .t-fn       { color: #d2a8ff; }
    .t-var      { color: #ffa657; }
    .t-num      { color: #79c0ff; }
    .t-accent   { color: var(--accent); }
    .t-prop     { color: #c9d1d9; }
    .t-green    { color: var(--green); }

    /* tab panes */
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }

    /* ─── TRUST BAR ───────────────────────────────────────────────────── */
    .trust-bar {
      border-top: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      padding: var(--space-5) 0;
      margin: var(--space-20) 0;
    }
    .trust-bar-inner {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--space-8);
      flex-wrap: wrap;
    }
    .trust-item {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-size: 13px;
      color: var(--text-secondary);
    }
    .trust-item svg {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
    }
    .trust-item .check { color: var(--green); }

    /* ─── SECTION HEADINGS ───────────────────────────────────────────── */
    .section { padding: var(--space-20) 0; }
    .section-label {
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
      margin-bottom: var(--space-4);
    }
    h2 {
      font-size: clamp(22px, 3vw, 30px);
      font-weight: 600;
      letter-spacing: -0.025em;
      line-height: 1.2;
      margin-bottom: var(--space-4);
    }
    .section-sub {
      font-size: 15px;
      color: var(--text-secondary);
      max-width: 520px;
      margin-bottom: var(--space-10);
      line-height: 1.6;
    }

    /* ─── HOW IT WORKS ───────────────────────────────────────────────── */
    .steps {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--space-4);
    }
    .step {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      padding: var(--space-6);
      position: relative;
    }
    .step-num {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 500;
      color: var(--text-tertiary);
      margin-bottom: var(--space-4);
    }
    .step h3 {
      font-size: 15px;
      font-weight: 600;
      margin-bottom: var(--space-2);
    }
    .step p {
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.55;
    }
    .step code {
      font-size: 12px;
      color: var(--accent);
      background: var(--accent-muted);
      padding: 1px 5px;
      border-radius: 3px;
    }

    /* ─── PRICING ────────────────────────────────────────────────────── */
    .pricing-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-mid);
      border-radius: var(--radius-lg);
      padding: var(--space-10) var(--space-8);
      max-width: 560px;
    }
    .price-display {
      display: flex;
      align-items: baseline;
      gap: var(--space-2);
      margin-bottom: var(--space-6);
    }
    .price-amount {
      font-family: var(--font-mono);
      font-size: 52px;
      font-weight: 500;
      letter-spacing: -0.04em;
      color: var(--text-primary);
    }
    .price-unit {
      font-family: var(--font-mono);
      font-size: 16px;
      color: var(--text-secondary);
    }
    .price-per {
      font-size: 14px;
      color: var(--text-secondary);
      margin-bottom: var(--space-8);
    }
    .price-math {
      display: inline-block;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--green);
    }
    .pricing-details {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-3);
      margin-bottom: var(--space-8);
    }
    .pricing-detail {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-size: 13px;
      color: var(--text-secondary);
    }
    .pricing-detail .check { color: var(--green); font-size: 14px; }
    .pricing-chain {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding-top: var(--space-6);
      border-top: 1px solid var(--border);
      font-size: 12px;
      color: var(--text-tertiary);
    }
    .chain-logo {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-family: var(--font-mono);
      color: var(--text-secondary);
    }
    .chain-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #0052ff;
      flex-shrink: 0;
    }

    /* ─── RESPONSE EXAMPLE ───────────────────────────────────────────── */
    .response-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-4);
      align-items: start;
    }
    .response-panel {
      background: var(--bg-code);
      border: 1px solid var(--border-mid);
      border-radius: var(--radius-md);
      overflow: hidden;
    }
    .response-panel-header {
      padding: var(--space-3) var(--space-4);
      border-bottom: 1px solid var(--border);
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-tertiary);
      background: var(--bg-surface);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .status-ok {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--green);
    }
    .response-body {
      padding: var(--space-4) var(--space-5);
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.7;
      color: #c9d1d9;
      overflow-x: auto;
    }
    .response-body pre { white-space: pre-wrap; word-break: break-word; }

    /* ─── AGENT LINKS ────────────────────────────────────────────────── */
    .agent-links {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: var(--space-4);
    }
    .agent-link-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      padding: var(--space-5);
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      transition: border-color 0.15s, background 0.15s;
      text-decoration: none;
    }
    .agent-link-card:hover {
      border-color: var(--border-mid);
      background: var(--bg-raised);
    }
    .agent-link-path {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--accent);
    }
    .agent-link-desc {
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.5;
    }
    .agent-link-arrow {
      margin-top: auto;
      font-size: 18px;
      color: var(--text-tertiary);
      transition: color 0.15s, transform 0.15s;
    }
    .agent-link-card:hover .agent-link-arrow {
      color: var(--accent);
      transform: translateX(3px);
    }

    /* ─── FOOTER ─────────────────────────────────────────────────────── */
    footer {
      border-top: 1px solid var(--border);
      padding: var(--space-10) 0;
    }
    .footer-inner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-6);
      flex-wrap: wrap;
    }
    .footer-logo {
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-tertiary);
    }
    .footer-logo span { color: var(--text-secondary); }
    .footer-links {
      display: flex;
      gap: var(--space-5);
    }
    .footer-links a {
      font-size: 13px;
      color: var(--text-tertiary);
      transition: color 0.15s;
    }
    .footer-links a:hover { color: var(--text-secondary); }
    .footer-copy {
      font-size: 12px;
      color: var(--text-tertiary);
      font-family: var(--font-mono);
    }

    /* ─── DIVIDER ────────────────────────────────────────────────────── */
    .divider {
      height: 1px;
      background: var(--border);
    }

    /* ─── UTILITIES ──────────────────────────────────────────────────── */
    .flex { display: flex; }
    .items-center { align-items: center; }
    .gap-2 { gap: var(--space-2); }
    .gap-4 { gap: var(--space-4); }
    .mt-2 { margin-top: var(--space-2); }
    .mb-4 { margin-bottom: var(--space-4); }

    /* ─── MOBILE ─────────────────────────────────────────────────────── */
    @media (max-width: 768px) {
      .nav-links .hide-mobile { display: none; }
      .steps { grid-template-columns: 1fr; }
      .response-grid { grid-template-columns: 1fr; }
      .agent-links { grid-template-columns: 1fr; }
      .pricing-details { grid-template-columns: 1fr; }
      .footer-inner { flex-direction: column; align-items: flex-start; gap: var(--space-4); }
      .hero { padding: var(--space-16) 0 var(--space-12); }
      .section { padding: var(--space-12) 0; }
      .trust-bar-inner { gap: var(--space-5); justify-content: flex-start; }
    }
    @media (max-width: 480px) {
      .container, .container--narrow { padding: 0 var(--space-4); }
      .nav-inner { padding: 0 var(--space-4); }
    }
  </style>
</head>
<body>

  <!-- ─── NAV ────────────────────────────────────────────────────────── -->
  <nav>
    <div class="nav-inner">
      <a href="/" class="nav-logo">extract<span>.</span>dkta<span>.dev</span></a>
      <div class="nav-links">
        <a href="/docs" class="hide-mobile">Docs</a>
        <a href="/llms.txt" class="hide-mobile">/llms.txt</a>
        <a href="/.well-known/ai-plugin.json" class="hide-mobile">/ai-plugin.json</a>
        <a href="/docs" class="nav-cta">Try it →</a>
      </div>
    </div>
  </nav>

  <!-- ─── HERO ────────────────────────────────────────────────────────── -->
  <section class="hero">
    <div class="container--narrow">
      <div class="hero-badge">x402 · Base · USDC</div>
      <h1>Clean content for<br><em>AI agents</em></h1>
      <p class="hero-sub">
        Extract LLM-ready markdown from any URL.
        <br>
        <span class="price-pill">$0.001 USDC per request</span>
        &nbsp;No account. No API key. No subscription.
      </p>

      <div class="hero-code-wrap">
        <div class="code-panel">
          <div class="code-panel-header">
            <div class="code-tabs">
              <button class="code-tab active" onclick="switchTab('js', this)">JavaScript</button>
              <button class="code-tab" onclick="switchTab('curl', this)">curl</button>
              <button class="code-tab" onclick="switchTab('python', this)">Python</button>
            </div>
            <button class="copy-btn" onclick="copyCode()">copy</button>
          </div>
          <div class="code-body">

            <div id="pane-js" class="tab-pane active">
<pre><span class="t-comment">// x402 pays automatically — no API keys, no auth headers</span>
<span class="t-keyword">import</span> { <span class="t-fn">withPaymentInterceptor</span> } <span class="t-keyword">from</span> <span class="t-string">"x402-fetch"</span>;

<span class="t-keyword">const</span> <span class="t-var">fetch</span> = <span class="t-fn">withPaymentInterceptor</span>(globalThis.fetch, wallet);

<span class="t-keyword">const</span> <span class="t-var">res</span> = <span class="t-keyword">await</span> <span class="t-fn">fetch</span>(
  <span class="t-string">"https://extract.dkta.dev/v1/extract?url=https://example.com&amp;format=markdown"</span>
);
<span class="t-keyword">const</span> { <span class="t-var">content</span>, <span class="t-var">title</span>, <span class="t-var">tokens</span> } = <span class="t-keyword">await</span> <span class="t-var">res</span>.<span class="t-fn">json</span>();
<span class="t-comment">// $0.001 USDC deducted on Base — charged only on success</span></pre>
            </div>

            <div id="pane-curl" class="tab-pane">
<pre><span class="t-comment"># x402: server returns 402 with payment details, client pays, retries</span>
<span class="t-fn">curl</span> <span class="t-string">"https://extract.dkta.dev/v1/extract?url=https://example.com&amp;format=markdown"</span>

<span class="t-comment"># with x402-curl (handles the payment handshake automatically):</span>
<span class="t-fn">x402-curl</span> <span class="t-string">"https://extract.dkta.dev/v1/extract?url=https://example.com"</span> \\
  --wallet <span class="t-var">$WALLET_PRIVATE_KEY</span></pre>
            </div>

            <div id="pane-python" class="tab-pane">
<pre><span class="t-keyword">from</span> x402.requests <span class="t-keyword">import</span> X402Session

<span class="t-var">session</span> = <span class="t-fn">X402Session</span>(wallet=<span class="t-var">wallet</span>)

<span class="t-var">res</span> = <span class="t-var">session</span>.<span class="t-fn">get</span>(
    <span class="t-string">"https://extract.dkta.dev/v1/extract"</span>,
    params={<span class="t-string">"url"</span>: <span class="t-string">"https://example.com"</span>, <span class="t-string">"format"</span>: <span class="t-string">"markdown"</span>},
)
<span class="t-var">content</span> = <span class="t-var">res</span>.<span class="t-fn">json</span>()[<span class="t-string">"content"</span>]
<span class="t-comment"># $0.001 USDC deducted on Base — no account needed</span></pre>
            </div>

          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- ─── TRUST BAR ────────────────────────────────────────────────────── -->
  <div class="trust-bar">
    <div class="container">
      <div class="trust-bar-inner">
        <div class="trust-item">
          <svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" class="check">
            <path d="M2 7.5L5.5 11L12 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          No account required
        </div>
        <div class="trust-item">
          <svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" class="check">
            <path d="M2 7.5L5.5 11L12 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          No subscription
        </div>
        <div class="trust-item">
          <svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" class="check">
            <path d="M2 7.5L5.5 11L12 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Failed requests not charged
        </div>
        <div class="trust-item">
          <svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" class="check">
            <path d="M2 7.5L5.5 11L12 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          Every payment on-chain, verifiable
        </div>
        <div class="trust-item">
          <svg viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" class="check">
            <path d="M2 7.5L5.5 11L12 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          No minimum spend
        </div>
      </div>
    </div>
  </div>

  <!-- ─── HOW IT WORKS ─────────────────────────────────────────────────── -->
  <section class="section">
    <div class="container">
      <p class="section-label">How it works</p>
      <h2>Three steps. No setup.</h2>
      <p class="section-sub">x402 is an open HTTP payment standard. Your agent pays per request — no billing portal, no invoices, no credit card forms.</p>
      <div class="steps">
        <div class="step">
          <div class="step-num">01</div>
          <h3>Send a request</h3>
          <p>Call <code>GET /v1/extract?url=...</code> with your x402-enabled client. The server responds with <code>402 Payment Required</code> and payment details.</p>
        </div>
        <div class="step">
          <div class="step-num">02</div>
          <h3>Pay on-chain</h3>
          <p>Your x402 client signs a <code>$0.001 USDC</code> payment on Base and retries the request with the payment proof attached. Happens automatically in milliseconds.</p>
        </div>
        <div class="step">
          <div class="step-num">03</div>
          <h3>Receive clean markdown</h3>
          <p>The API returns clean, LLM-ready content — stripped of nav, ads, and boilerplate. Failed extractions are not charged.</p>
        </div>
      </div>
    </div>
  </section>

  <div class="divider"></div>

  <!-- ─── RESPONSE EXAMPLE ─────────────────────────────────────────────── -->
  <section class="section">
    <div class="container">
      <p class="section-label">Response</p>
      <h2>What you get back</h2>
      <p class="section-sub">Clean structured JSON. The <code>content</code> field is ready to drop directly into your context window.</p>
      <div class="response-grid">
        <div class="response-panel">
          <div class="response-panel-header">
            <span>Request</span>
          </div>
          <div class="response-body">
<pre><span class="t-fn">GET</span> <span class="t-string">/v1/extract</span>
  <span class="t-var">?url</span>=https://en.wikipedia.org/wiki/Markdown
  <span class="t-var">&amp;format</span>=markdown

<span class="t-comment">X-PAYMENT: &lt;x402-proof&gt;
Host: extract.dkta.dev</span></pre>
          </div>
        </div>
        <div class="response-panel">
          <div class="response-panel-header">
            <span>Response</span>
            <span class="status-ok">200 OK</span>
          </div>
          <div class="response-body">
<pre>{
  <span class="t-prop">"title"</span>: <span class="t-string">"Markdown - Wikipedia"</span>,
  <span class="t-prop">"url"</span>: <span class="t-string">"https://en.wikipedia.org/wiki/Markdown"</span>,
  <span class="t-prop">"format"</span>: <span class="t-string">"markdown"</span>,
  <span class="t-prop">"content"</span>: <span class="t-string">"# Markdown\\n\\nMarkdown is a lightweight markup language..."</span>,
  <span class="t-prop">"tokens"</span>: <span class="t-num">1842</span>,
  <span class="t-prop">"charged_usdc"</span>: <span class="t-num">0.001</span>
}</pre>
          </div>
        </div>
      </div>
    </div>
  </section>

  <div class="divider"></div>

  <!-- ─── PRICING ──────────────────────────────────────────────────────── -->
  <section class="section">
    <div class="container">
      <p class="section-label">Pricing</p>
      <h2>Simple math.</h2>
      <p class="section-sub">One price. Per request. No tiers, no credits, no expiry.</p>
      <div class="pricing-card">
        <div class="price-display">
          <span class="price-amount">$0.001</span>
          <span class="price-unit">USDC</span>
        </div>
        <p class="price-per">per request &nbsp;·&nbsp; <span class="price-math">$1.00 = 1,000 requests</span> &nbsp;·&nbsp; <span class="price-math">$10.00 = 10,000 requests</span></p>

        <div class="pricing-details">
          <div class="pricing-detail"><span class="check">✓</span> No account required</div>
          <div class="pricing-detail"><span class="check">✓</span> No subscription</div>
          <div class="pricing-detail"><span class="check">✓</span> No minimum spend</div>
          <div class="pricing-detail"><span class="check">✓</span> Failed requests not charged</div>
          <div class="pricing-detail"><span class="check">✓</span> No API key needed</div>
          <div class="pricing-detail"><span class="check">✓</span> Pay per use, stop anytime</div>
        </div>

        <div class="pricing-chain">
          <div class="chain-logo">
            <div class="chain-dot"></div>
            Paid via x402 on Base network
          </div>
          <span>·</span>
          <a href="https://x402.org" style="color: var(--text-tertiary); transition: color 0.15s;" onmouseover="this.style.color='var(--text-secondary)'" onmouseout="this.style.color='var(--text-tertiary)'">x402.org ↗</a>
        </div>
      </div>
    </div>
  </section>

  <div class="divider"></div>

  <!-- ─── AGENT DISCOVERY LINKS ────────────────────────────────────────── -->
  <section class="section">
    <div class="container">
      <p class="section-label">Agent discovery</p>
      <h2>Built for agents and tools.</h2>
      <p class="section-sub">Standard discovery endpoints so your LLM, agent framework, or tool orchestrator can find and use this API without human configuration.</p>
      <div class="agent-links">
        <a href="/docs" class="agent-link-card">
          <div class="agent-link-path">/docs</div>
          <div class="agent-link-desc">Interactive API explorer. OpenAPI spec with live request testing.</div>
          <div class="agent-link-arrow">→</div>
        </a>
        <a href="/llms.txt" class="agent-link-card">
          <div class="agent-link-path">/llms.txt</div>
          <div class="agent-link-desc">Plain-text API description for direct LLM consumption. Paste into any context window.</div>
          <div class="agent-link-arrow">→</div>
        </a>
        <a href="/.well-known/ai-plugin.json" class="agent-link-card">
          <div class="agent-link-path">/.well-known/ai-plugin.json</div>
          <div class="agent-link-desc">ChatGPT / agent plugin manifest. Add as a custom tool in any OpenAI-compatible agent.</div>
          <div class="agent-link-arrow">→</div>
        </a>
      </div>
    </div>
  </section>

  <!-- ─── FOOTER ───────────────────────────────────────────────────────── -->
  <footer>
    <div class="container">
      <div class="footer-inner">
        <div class="footer-logo">
          extract<span>.dkta.dev</span>
        </div>
        <div class="footer-links">
          <a href="/docs">API Docs</a>
          <a href="/llms.txt">/llms.txt</a>
          <a href="/.well-known/ai-plugin.json">ai-plugin.json</a>
        </div>
        <div class="footer-copy">x402 · Base · USDC</div>
      </div>
    </div>
  </footer>

  <script>
    function switchTab(id, btn) {
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.code-tab').forEach(t => t.classList.remove('active'));
      document.getElementById('pane-' + id).classList.add('active');
      btn.classList.add('active');
    }

    function copyCode() {
      const activePane = document.querySelector('.tab-pane.active pre');
      if (!activePane) return;
      const text = activePane.innerText;
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.querySelector('.copy-btn');
        const orig = btn.textContent;
        btn.textContent = 'copied!';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      });
    }
  </script>

</body>
</html>`)
})

// Serve llms.txt
app.get('/llms.txt', (_req, res) => {
  res.type('text/plain').sendFile('/opt/extract/public/llms.txt')
})

// Well-known ai-plugin.json for agent autodiscovery
app.get('/.well-known/ai-plugin.json', (_req, res) => {
  res.json({
    schema_version: 'v1',
    name_for_human: 'extract.dkta.dev',
    name_for_model: 'extract',
    description_for_human: 'Extract clean markdown or text from any URL. Pay $0.001 USDC per call via x402 on Base.',
    description_for_model: 'Extracts clean readable content (markdown or plain text) from any URL using crawl4ai. Requires x402 micropayment of $0.001 USDC on Base mainnet. Use GET /v1/extract?url=<url>&format=markdown',
    auth: { type: 'none' },
    api: { type: 'openapi', url: 'https://extract.dkta.dev/openapi.json' },
    logo_url: 'https://extract.dkta.dev/logo.png',
    contact_email: 'hi@dkta.dev',
    legal_info_url: 'https://dkta.dev',
  })
})

// Well-known x402.json for agent framework autodiscovery
const x402Manifest = {
  version: '1',
  x402Version: 2,
  endpoints: [
    {
      path: '/v1/extract',
      method: 'GET',
      network: 'base',
      caip2Network: 'eip155:8453',
      asset: 'USDC',
      description: 'Extract clean, LLM-ready markdown from any URL.',
    },
    {
      path: '/v1/extract/batch',
      method: 'POST',
      network: 'base',
      caip2Network: 'eip155:8453',
      asset: 'USDC',
      description: 'Batch extract clean, LLM-ready markdown from up to 5 URLs.',
    },
  ],
}
app.get('/.well-known/x402.json', (_req, res) => res.json(x402Manifest))
// Non-.json alias for agents/indexers that probe both variants
app.get('/.well-known/x402', (_req, res) => res.json(x402Manifest))

const server = app.listen(PORT, () => {
  console.log(`extract API running on :${PORT} (network: ${NETWORK}, payTo: ${PAYMENT_ADDRESS})`)
})

// Keep event loop alive under systemd (no TTY)
setInterval(() => {}, 1 << 30)

process.on('SIGTERM', () => { server.close(() => process.exit(0)) })
process.on('SIGINT', () => { server.close(() => process.exit(0)) })
