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
