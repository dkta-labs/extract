import express from 'express'
import { paymentMiddleware, x402ResourceServer } from '@x402/express'
import { HTTPFacilitatorClient } from '@x402/core/server'
import { registerExactEvmScheme } from '@x402/evm/exact/server'
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from '@x402/extensions/bazaar'
import { createCdpAuthHeaders } from '@coinbase/x402'
import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import fetch from 'node-fetch'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { Agent as HttpAgent } from 'node:http'
import { Agent as HttpsAgent } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { startRequestLogMaintenance } from './request-log.js'
import {
  BATCH_EXTRACTION_UNITS,
  CreditError,
  SINGLE_EXTRACTION_UNITS,
  createCreditService,
} from './credits.js'

const LOG_PATH = process.env.LOG_PATH || '/srv/dkta/extract/logs/requests.jsonl'

startRequestLogMaintenance(LOG_PATH)

function logRequest(entry) {
  try {
    fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n')
  } catch (error) {
    console.warn(`request log failed: ${error.message}`)
  }
}

const UMAMI_URL = process.env.UMAMI_URL || 'http://localhost:3725/api/send'
const UMAMI_SITE_ID = '5eeb856b-0ecd-4acd-9208-8fb522b41bf7'
const CRAWL4AI_URL = process.env.CRAWL4AI_URL || 'http://localhost:11235/md'
async function umamiEvent(name, data = {}, url = '/') {
  try {
    const response = await fetch(UMAMI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      },
      body: JSON.stringify({
        payload: {
          website: UMAMI_SITE_ID,
          hostname: 'extract.dkta.dev',
          language: 'en-US',
          referrer: '',
          screen: 'server',
          title: 'Extract API',
          url,
          name,
          data,
        },
        type: 'event',
      }),
    })
    if (!response.ok) {
      console.warn(`analytics event ${name} failed: HTTP ${response.status}`)
    }
  } catch (error) {
    console.warn(`analytics event ${name} failed: ${error.message}`)
  }
}

const app = express()
app.set('trust proxy', true) // Cloudflare + Caddy sit in front
const PORT = process.env.PORT || 3721
const PAYMENT_ADDRESS = process.env.PAYMENT_ADDRESS
const NETWORK = process.env.NETWORK || 'eip155:8453'
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://extract.dkta.dev'
const creditService = createCreditService(process.env, PUBLIC_URL)

if (!PAYMENT_ADDRESS || !/^0x[0-9a-fA-F]{40}$/.test(PAYMENT_ADDRESS)) {
  throw new Error('PAYMENT_ADDRESS must be set to a valid EVM address')
}
if (NETWORK !== 'eip155:8453') {
  throw new Error('NETWORK must be eip155:8453')
}

const blockedAddresses = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  blockedAddresses.addSubnet(address, prefix, 'ipv4')
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]) {
  blockedAddresses.addSubnet(address, prefix, 'ipv6')
}

function requestEndpoint(req) {
  const rawPath = req.originalUrl.split(/[?#]/, 1)[0]
  let path
  try {
    path = decodeURIComponent(rawPath)
  } catch {
    path = rawPath
  }
  path = path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/(.+?)\/+$/, '$1').toLowerCase()
  if (req.method === 'GET' && path === '/v1/extract') return '/v1/extract'
  if (req.method === 'POST' && path === '/v1/extract/batch') return '/v1/extract/batch'
  return null
}

function isBlockedAddress(address, family) {
  const normalized = address.split('%')[0].toLowerCase()
  if (family === 6) {
    const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16)
      const low = Number.parseInt(mappedHex[2], 16)
      const mappedIPv4 = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
      return blockedAddresses.check(mappedIPv4, 'ipv4')
    }
    const mappedDecimal = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
    if (mappedDecimal) return blockedAddresses.check(mappedDecimal[1], 'ipv4')
  }
  return blockedAddresses.check(normalized, family === 6 ? 'ipv6' : 'ipv4')
}

async function resolveTargetUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new Error('url must be a string between 1 and 2048 characters')
  }

  let targetUrl
  try {
    targetUrl = new URL(value)
  } catch {
    throw new Error('url must be fully qualified')
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    throw new Error('url must use http or https')
  }
  if (targetUrl.username || targetUrl.password) {
    throw new Error('url must not contain credentials')
  }

  const hostname = targetUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('url hostname is not publicly routable')
  }

  const literalFamily = isIP(hostname)
  let addresses
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new Error('url hostname could not be resolved')
  }

  if (addresses.length === 0 || addresses.some(({ address, family }) => isBlockedAddress(address, family))) {
    throw new Error('url hostname is not publicly routable')
  }

  return { targetUrl, addresses }
}

async function validateTargetUrl(value) {
  return (await resolveTargetUrl(value)).targetUrl
}

function targetHostname(targetUrl) {
  return targetUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

function recordSingleFailure(req, format, ts, start, status, reason) {
  const endpoint = '/v1/extract'
  const event = {
    request_id: req.requestId,
    payment_method: req.paymentMethod,
    target_hostname: targetHostname(req.targetUrl),
    status,
    format,
    duration_ms: Date.now() - start,
    reason,
  }
  logRequest({ ts, event: 'failure', endpoint, ...event })
  void umamiEvent('extract-request', event, endpoint)
}

function batchTargetTelemetry(targetUrls, results) {
  const telemetry = {}
  for (let index = 0; index < targetUrls.length; index += 1) {
    const slot = index + 1
    telemetry[`target_hostname_${slot}`] = targetHostname(targetUrls[index])
    telemetry[`target_outcome_${slot}`] = results[index].error ? 'failure' : 'success'
  }
  return telemetry
}

async function fetchPublicUrl(initialUrl, options = {}, timeoutMs = 10000) {
  const signal = AbortSignal.timeout(timeoutMs)
  let targetUrl = initialUrl

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const resolved = await resolveTargetUrl(targetUrl.toString())
    targetUrl = resolved.targetUrl
    const selected = resolved.addresses.find(({ family }) => family === 4) || resolved.addresses[0]
    const pinnedLookup = (_hostname, lookupOptions, callback) => lookupOptions?.all
      ? callback(null, [selected])
      : callback(null, selected.address, selected.family)
    const agent = targetUrl.protocol === 'https:'
      ? new HttpsAgent({ lookup: pinnedLookup })
      : new HttpAgent({ lookup: pinnedLookup })
    const response = await fetch(targetUrl, {
      ...options,
      agent,
      redirect: 'manual',
      signal,
    })

    if (![301, 302, 303, 307, 308].includes(response.status)) return response

    const location = response.headers.get('location')
    response.body?.destroy()
    if (!location) throw new Error('upstream redirect is missing a location')
    targetUrl = new URL(location, targetUrl)
  }

  throw new Error('upstream returned too many redirects')
}

// CORS headers required so browser-based agents can read 402 challenges and payment headers.
// Scoped to /v1/extract and discovery endpoints only — not applied globally.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, payment-signature, x-request-id, authorization',
  'Access-Control-Expose-Headers': 'payment-required, payment-response, x-request-id, x-credit-balance',
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
app.options(['/v1/credits/checkout', '/v1/credits/claim', '/v1/credits/balance'], (req, res) => {
  applyCors(res)
  res.sendStatus(200)
})

// Scoped CORS — only /v1/extract routes and well-known discovery routes
app.use([
  '/v1/extract',
  '/v1/extract/batch',
  '/v1/credits/checkout',
  '/v1/credits/claim',
  '/v1/credits/balance',
  '/.well-known/x402',
  '/.well-known/x402.json',
  '/openapi.json',
], (req, res, next) => {
  applyCors(res)
  next()
})

function prepaidUnavailable(res) {
  res.setHeader('Cache-Control', 'private, no-store')
  return res.status(503).json({
    error: 'prepaid card checkout is not configured',
    code: 'prepaid_unavailable',
  })
}

function sendCreditError(res, error) {
  const creditError = error instanceof CreditError
    ? error
    : new CreditError('prepaid_internal_error', 'prepaid credit operation failed', 500)
  res.setHeader('Cache-Control', 'private, no-store')
  return res.status(creditError.status).json({
    error: creditError.message,
    code: creditError.code,
    ...creditError.details,
  })
}

function bearerApiKey(req) {
  const authorization = req.get('authorization')
  if (!authorization) return null
  const match = authorization.match(/^Bearer\s+(\S+)$/i)
  return match ? match[1] : null
}


app.post(
  '/v1/credits/stripe-webhook',
  express.raw({ type: 'application/json', limit: '128kb' }),
  (req, res) => {
    if (!creditService) return prepaidUnavailable(res)
    try {
      const result = creditService.handleWebhook(req.body, req.get('stripe-signature'))
      logRequest({
        ts: new Date().toISOString(),
        event: 'credit_webhook',
        duplicate: Boolean(result.duplicate),
        ignored: Boolean(result.ignored),
      })
      return res.json({ received: true })
    } catch (error) {
      console.warn(`credit webhook rejected: ${error.message}`)
      return sendCreditError(res, error instanceof CreditError
        ? error
        : new CreditError('invalid_webhook', 'invalid Stripe webhook', 400))
    }
  }
)

function sendCreditCheckout(res) {
  if (!creditService) return prepaidUnavailable(res)
  const checkout = creditService.checkout
  res.setHeader('Cache-Control', 'public, max-age=300')
  return res.json({
    checkout_url: checkout.checkoutUrl,
    credit_units: checkout.units,
    single_extractions: Math.floor(checkout.units / SINGLE_EXTRACTION_UNITS),
    price_usd: checkout.amountCents / 100,
  })
}
app.get('/v1/credits/checkout', (_req, res) => sendCreditCheckout(res))

app.post('/v1/credits/claim', express.json({ limit: '2kb' }), (req, res) => {
  if (!creditService) return prepaidUnavailable(res)
  try {
    const apiKey = req.body?.api_key
    const claim = creditService.ledger.claimCheckout(req.body?.session_id, apiKey)
    res.setHeader('Cache-Control', 'private, no-store')
    if (!claim.alreadyClaimed) {
      logRequest({
        ts: new Date().toISOString(),
        event: 'credit_key_claimed',
        key_prefix: apiKey.slice(0, 17),
        balance_units: claim.balanceUnits,
      })
    }
    return res.json({
      api_key: apiKey,
      balance_units: claim.balanceUnits,
      single_extractions_remaining: Math.floor(claim.balanceUnits / SINGLE_EXTRACTION_UNITS),
      warning: 'Copy this API key now. Only its hash is stored.',
    })
  } catch (error) {
    return sendCreditError(res, error)
  }
})
app.use('/v1/credits/claim', (error, _req, res, next) => {
  if (!error) return next()
  return sendCreditError(res, new CreditError('invalid_json', 'request body must be valid JSON'))
})

app.get('/v1/credits/balance', (req, res) => {
  if (!creditService) return prepaidUnavailable(res)
  try {
    const key = creditService.ledger.inspectApiKey(bearerApiKey(req))
    res.setHeader('Cache-Control', 'private, no-store')
    return res.json({
      key_prefix: key.keyPrefix,
      balance_units: key.balanceUnits,
      single_extractions_remaining: Math.floor(key.balanceUnits / SINGLE_EXTRACTION_UNITS),
    })
  } catch (error) {
    return sendCreditError(res, error)
  }
})

function isSuccessfulSettlementHeader(value) {
  if (!value) return false
  try {
    return JSON.parse(Buffer.from(String(value), 'base64').toString()).success === true
  } catch {
    return false
  }
}

app.use(['/v1/extract', '/v1/extract/batch'], (req, res, next) => {
  if (!requestEndpoint(req)) return next()
  const suppliedRequestId = req.get('x-request-id')
  req.requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedRequestId || '')
    ? suppliedRequestId
    : randomUUID()
  res.setHeader('X-Request-ID', req.requestId)
  const endpoint = requestEndpoint(req)
  res.once('finish', () => {
    if (!isSuccessfulSettlementHeader(res.getHeader('PAYMENT-RESPONSE'))) return
    const event = { request_id: req.requestId, endpoint, method: req.method }
    logRequest({ ts: new Date().toISOString(), event: 'payment_settled', ...event })
    void umamiEvent('payment-settled', event, endpoint)
  })
  next()
})

// Ensure 402 responses are never cached regardless of how paymentMiddleware sends them.
// Hook writeHead so this fires even if the x402 middleware uses res.send/res.end rather than res.json.
app.use(['/v1/extract', '/v1/extract/batch'], (req, res, next) => {
  const endpoint = requestEndpoint(req)
  let challengeTracked = false
  const _writeHead = res.writeHead.bind(res)
  res.writeHead = function (statusCode, ...args) {
    if (statusCode === 402) {
      res.setHeader('Cache-Control', 'private, no-store')
      if (endpoint && !challengeTracked) {
        challengeTracked = true
        const event = {
          request_id: req.requestId,
          endpoint,
          method: req.method,
        }
        logRequest({ ts: new Date().toISOString(), event: 'payment_challenge', ...event })
        void umamiEvent('payment-challenge', event, endpoint)
      }
    }
    return _writeHead(statusCode, ...args)
  }
  next()
})

function rejectBadRequest(req, res, reason, message, endpoint) {
  const event = {
    request_id: req.requestId,
    endpoint,
    status: 400,
    reason,
    paid: false,
  }
  logRequest({ ts: new Date().toISOString(), event: 'bad_request', ...event })
  void umamiEvent('request-rejected', event, endpoint)
  return res.status(400).json({ error: message })
}

app.use('/v1/extract/batch', express.json({ limit: '16kb' }))
app.use('/v1/extract/batch', (error, req, res, next) => {
  if (!error) return next()
  return rejectBadRequest(req, res, 'invalid_json', 'request body must be valid JSON', '/v1/extract/batch')
})

app.get('/v1/extract', async (req, res, next) => {
  const { url, format = 'markdown' } = req.query
  if (!['markdown', 'text'].includes(format)) {
    return rejectBadRequest(req, res, 'invalid_format', 'format must be markdown or text', '/v1/extract')
  }
  try {
    req.targetUrl = await validateTargetUrl(url)
  } catch (error) {
    return rejectBadRequest(req, res, 'invalid_url', error.message, '/v1/extract')
  }
  next()
})

app.post('/v1/extract/batch', async (req, res, next) => {
  const { urls, format = 'markdown' } = req.body || {}
  if (!Array.isArray(urls) || urls.length === 0) {
    return rejectBadRequest(req, res, 'missing_urls', 'urls array required', '/v1/extract/batch')
  }
  if (urls.length > 5) {
    return rejectBadRequest(req, res, 'too_many_urls', 'maximum 5 URLs per batch request', '/v1/extract/batch')
  }
  if (!['markdown', 'text'].includes(format)) {
    return rejectBadRequest(req, res, 'invalid_format', 'format must be markdown or text', '/v1/extract/batch')
  }

  req.targetUrls = []
  for (let index = 0; index < urls.length; index += 1) {
    try {
      req.targetUrls.push(await validateTargetUrl(urls[index]))
    } catch (error) {
      return rejectBadRequest(
        req,
        res,
        'invalid_url',
        `invalid url at index ${index}: ${error.message}`,
        '/v1/extract/batch'
      )
    }
  }
  req.outputFormat = format
  next()
})

app.use(['/v1/extract', '/v1/extract/batch'], (req, res, next) => {
  const authorization = req.get('authorization')
  if (!authorization) return next()
  if (!/^Bearer\s/i.test(authorization)) return next()
  const apiKey = bearerApiKey(req)
  if (!apiKey) {
    return sendCreditError(res, new CreditError('invalid_api_key', 'invalid prepaid API key', 401))
  }
  if (!creditService) return prepaidUnavailable(res)

  const endpoint = requestEndpoint(req)
  const units = endpoint === '/v1/extract/batch'
    ? BATCH_EXTRACTION_UNITS
    : SINGLE_EXTRACTION_UNITS
  try {
    const reservation = creditService.ledger.reserve(
      apiKey,
      req.requestId,
      endpoint,
      units
    )
    req.paymentMethod = 'prepaid'
    res.setHeader('X-Credit-Balance', String(reservation.balanceUnits))
    const event = {
      request_id: req.requestId,
      endpoint,
      method: req.method,
      payment_method: 'prepaid',
      key_prefix: reservation.keyPrefix,
      credit_units: units,
      balance_units: reservation.balanceUnits,
    }
    logRequest({ ts: new Date().toISOString(), event: 'credit_reserved', ...event })
    void umamiEvent('credit-reserved', event, endpoint)

    let finalized = false
    const finalize = succeeded => {
      if (finalized) return
      finalized = true
      try {
        const settlement = creditService.ledger.settle(
          reservation.apiKeyId,
          req.requestId,
          succeeded
        )
        const settledEvent = {
          ...event,
          balance_units: settlement.balanceUnits,
        }
        logRequest({
          ts: new Date().toISOString(),
          event: succeeded ? 'credit_committed' : 'credit_released',
          ...settledEvent,
        })
        void umamiEvent(
          succeeded ? 'credit-committed' : 'credit-released',
          settledEvent,
          endpoint
        )
      } catch (error) {
        console.error(`credit settlement failed for ${req.requestId}: ${error.message}`)
      }
    }
    res.once('finish', () => finalize(res.statusCode >= 200 && res.statusCode < 300))
    res.once('close', () => {
      if (!res.writableFinished) finalize(false)
    })
    return next()
  } catch (error) {
    return sendCreditError(res, error)
  }
})

// x402 v2 payment gate — $0.001 per extraction, $0.005 per batch.
const facilitatorClient = new HTTPFacilitatorClient(
  process.env.FACILITATOR_URL
    ? { url: process.env.FACILITATOR_URL }
    : {
        url: 'https://api.cdp.coinbase.com/platform/v2/x402',
        createAuthHeaders: createCdpAuthHeaders(
          process.env.CDP_API_KEY_ID,
          process.env.CDP_API_KEY_SECRET
        ),
      }
)
const resourceServer = new x402ResourceServer(facilitatorClient)
registerExactEvmScheme(resourceServer, { networks: [NETWORK] })
resourceServer.registerExtension(bazaarResourceServerExtension)

const x402PaymentGate = paymentMiddleware(
  {
    'GET /v1/extract': {
      accepts: {
        scheme: 'exact',
        price: '$0.001',
        network: NETWORK,
        payTo: PAYMENT_ADDRESS,
        maxTimeoutSeconds: 60,
      },
      resource: `${PUBLIC_URL}/v1/extract`,
      description: 'Extract clean, LLM-ready markdown or text from a public HTTP(S) URL',
      mimeType: 'application/json',
      serviceName: 'Extract',
      tags: ['content-extraction', 'markdown', 'ai-agents'],
      iconUrl: `${PUBLIC_URL}/logo.svg`,
      extensions: declareDiscoveryExtension({
        input: {
          url: 'https://example.com/article',
          format: 'markdown',
        },
        inputSchema: {
          properties: {
            url: { type: 'string', format: 'uri', description: 'Fully-qualified public HTTP(S) URL' },
            format: { type: 'string', enum: ['markdown', 'text'], default: 'markdown' },
          },
          required: ['url'],
          additionalProperties: false,
        },
        output: {
          example: {
            title: 'Article Title',
            byline: null,
            url: 'https://example.com/article',
            content: '# Markdown...',
            length: 4821,
            word_count: 800,
            extraction_method: 'crawl4ai',
            lang: 'en',
          },
          schema: {
            properties: {
              title: { type: ['string', 'null'] },
              byline: { type: ['string', 'null'] },
              url: { type: 'string', format: 'uri' },
              content: { type: ['string', 'null'] },
              length: { type: 'integer' },
              word_count: { type: 'integer' },
              extraction_method: { type: 'string', enum: ['crawl4ai', 'readability'] },
              lang: { type: 'string' },
            },
            required: ['title', 'byline', 'url', 'content', 'length', 'word_count', 'extraction_method', 'lang'],
            additionalProperties: false,
          },
        },
      }),
    },
    'POST /v1/extract/batch': {
      accepts: {
        scheme: 'exact',
        price: '$0.005',
        network: NETWORK,
        payTo: PAYMENT_ADDRESS,
        maxTimeoutSeconds: 60,
      },
      resource: `${PUBLIC_URL}/v1/extract/batch`,
      description: 'Batch extract clean, LLM-ready markdown or text from 1 to 5 public HTTP(S) URLs',
      mimeType: 'application/json',
      serviceName: 'Extract',
      tags: ['content-extraction', 'batch', 'markdown', 'ai-agents'],
      iconUrl: `${PUBLIC_URL}/logo.svg`,
      extensions: declareDiscoveryExtension({
        bodyType: 'json',
        input: {
          urls: ['https://example.com/article'],
          format: 'markdown',
        },
        inputSchema: {
          properties: {
            urls: {
              type: 'array',
              items: { type: 'string', format: 'uri' },
              minItems: 1,
              maxItems: 5,
            },
            format: { type: 'string', enum: ['markdown', 'text'], default: 'markdown' },
          },
          required: ['urls'],
          additionalProperties: false,
        },
        output: {
          example: {
            results: [{
              title: 'Article Title',
              byline: null,
              url: 'https://example.com/article',
              content: '# Markdown...',
              length: 4821,
              word_count: 800,
              extraction_method: 'crawl4ai',
              lang: 'en',
            }],
          },
        },
      }),
    },
  },
  resourceServer
)

app.use((req, res, next) => {
  if (!requestEndpoint(req)) return next()
  if (req.paymentMethod === 'prepaid') return next()
  return x402PaymentGate(req, res, error => {
    if (!error) req.paymentMethod = 'x402'
    next(error)
  })
})

app.use(['/v1/extract', '/v1/extract/batch'], (req, _res, next) => {
  const endpoint = requestEndpoint(req)
  if (!endpoint) return next()
  const event = {
    request_id: req.requestId,
    endpoint,
    method: req.method,
    payment_method: req.paymentMethod,
  }
  logRequest({ ts: new Date().toISOString(), event: 'payment_authorized', ...event })
  void umamiEvent('payment-authorized', event, endpoint)
  next()
})

// Simple language detection: check first 100 chars for CJK codepoints, default to 'en'
function detectLang(text) {
  const sample = text ? text.slice(0, 100) : ''
  if (/[\u3000-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/.test(sample)) return 'zh'
  return 'en'
}

app.get('/v1/extract', async (req, res) => {
  const { format = 'markdown' } = req.query
  const targetUrl = req.targetUrl
  const ts = new Date().toISOString()
  const start = Date.now()

  try {
    // Try crawl4ai first
    let markdownContent = null
    let title = null
    let byline = null
    let extraction_method = 'readability'

    try {
      const crawlRes = await fetch(CRAWL4AI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: targetUrl.toString(), f: 'fit' }),
        signal: AbortSignal.timeout(15000),
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
      const response = await fetchPublicUrl(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; extract-api/1.0)' },
      })

      if (!response.ok) {
        recordSingleFailure(req, format, ts, start, 502, 'upstream_error')
        return res.status(502).json({ error: `upstream returned ${response.status}` })
      }

      const html = await response.text()
      const dom = new JSDOM(html, { url: targetUrl.toString() })
      const reader = new Readability(dom.window.document)
      const article = reader.parse()

      if (!article) {
        recordSingleFailure(req, format, ts, start, 422, 'not_readable')
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
    const target_hostname = targetHostname(targetUrl)
    const event = { request_id: req.requestId, payment_method: req.paymentMethod, status: 200, target_hostname, format, length: content.length, duration_ms }
    logRequest({ ts, event: 'success', endpoint: '/v1/extract', ...event })
    void umamiEvent('extract-request', event, '/v1/extract')
    return res.json(result)
  } catch (err) {
    recordSingleFailure(req, format, ts, start, 500, 'internal_error')
    return res.status(500).json({ error: err.message })
  }
})

// ─── Batch extraction endpoint ────────────────────────────────────────────────
app.post('/v1/extract/batch', async (req, res) => {
  const ts = new Date().toISOString()
  const start = Date.now()
  const urls = req.targetUrls
  const format = req.outputFormat

  // Helper to extract a single URL (reuses same crawl4ai → Readability logic)
  async function extractOne(targetUrl) {
    try {
      let markdownContent = null
      let title = null
      let byline = null
      let extraction_method = 'readability'

      try {
        const crawlRes = await fetch(CRAWL4AI_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: targetUrl.toString(), f: 'fit' }),
          signal: AbortSignal.timeout(15000),
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
        const response = await fetchPublicUrl(targetUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; extract-api/1.0)' },
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
      return { url: targetUrl.toString(), error: err.message }
    }
  }

  try {
    const results = await Promise.all(urls.map(extractOne))
    const duration_ms = Date.now() - start
    const failure_count = results.filter(result => result.error).length
    const targetTelemetry = batchTargetTelemetry(urls, results)
    const event = { request_id: req.requestId, payment_method: req.paymentMethod, status: 200, format, count: urls.length, failure_count, duration_ms, ...targetTelemetry }
    logRequest({ ts, event: 'success', endpoint: '/v1/extract/batch', ...event })
    void umamiEvent('extract-batch', event, '/v1/extract/batch')
    return res.json({ results })
  } catch (err) {
    void umamiEvent('extract-batch', { request_id: req.requestId, payment_method: req.paymentMethod, status: 500, reason: 'internal_error' }, '/v1/extract/batch')
    return res.status(500).json({ error: err.message })
  }
})

// ─── OpenAPI spec ────────────────────────────────────────────────────────────
const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'extract.dkta.dev',
    version: '2.1.0',
    description:
      'Clean content extraction for AI agents. A single request costs **$0.001** ' +
      'and a batch of up to 5 URLs costs **$0.005**. Pay per request with USDC on Base through ' +
      '[x402](https://x402.org), or prepay $10 by card for a bearer API key. Inputs are validated before charging. ' +
      'A single extraction is charged only after a successful response. A batch is charged on its HTTP 200 response, including when individual items contain inline errors.',
  },
  servers: [{ url: 'https://extract.dkta.dev', description: 'Production' }],
  paths: {
    '/v1/extract': {
      get: {
        summary: 'Extract readable content from a URL',
        description:
          'Fetches the target URL with Crawl4AI first, then falls back to Mozilla Readability, ' +
          'and returns structured markdown or plain text. Pay with an x402 v2 micropayment ' +
          '($0.001 USDC on Base mainnet) or a prepaid bearer API key.',
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
          {
            name: 'X-Request-ID',
            in: 'header',
            required: false,
            description: 'Client-generated UUID. Reuse it on the paid retry to correlate authorization, extraction, and settlement.',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        security: [{ x402Payment: [] }, { apiKeyAuth: [] }],
        responses: {
          '200': {
            description: 'Extracted content',
            headers: {
              'X-Request-ID': {
                description: 'Request lifecycle UUID.',
                schema: { type: 'string', format: 'uuid' },
              },
              'PAYMENT-RESPONSE': {
                description: 'Base64-encoded x402 settlement receipt.',
                schema: { type: 'string' },
              },
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
                  required: ['title', 'byline', 'url', 'content', 'length', 'word_count', 'extraction_method', 'lang'],
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
            description: 'Bad request — invalid format, URL, scheme, credentials, or non-public target. Rejected before payment.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          '402': {
            description:
              'Payment required. Decode the base64 `PAYMENT-REQUIRED` header, sign one ' +
              'accepted payment option, and retry with the result in `PAYMENT-SIGNATURE`.',
            headers: {
              'X-Request-ID': {
                description: 'Client-generated UUID. Send the same value on the paid retry to correlate the lifecycle.',
                schema: { type: 'string', format: 'uuid' },
              },
              'PAYMENT-REQUIRED': {
                description: 'Base64-encoded x402 v2 payment requirements, including Bazaar discovery metadata.',
                schema: { type: 'string' },
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
          'Accepts 1 to 5 URLs for a flat **$0.005** charge and returns an array of results. ' +
          'Use x402 on Base or a prepaid bearer API key. The entire input is validated before charging. ' +
          'The HTTP 200 response incurs the full batch charge, including when per-URL upstream or extraction errors are returned inline.',
        operationId: 'extractBatch',
        parameters: [
          {
            name: 'X-Request-ID',
            in: 'header',
            required: false,
            description: 'Client-generated UUID. Reuse it on the paid retry to correlate authorization, extraction, and settlement.',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        security: [{ x402Payment: [] }, { apiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  urls:   { type: 'array', items: { type: 'string', format: 'uri' }, minItems: 1, maxItems: 5, description: 'Array of 1 to 5 URLs to extract' },
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
              'X-Request-ID': {
                description: 'Request lifecycle UUID.',
                schema: { type: 'string', format: 'uuid' },
              },
              'PAYMENT-RESPONSE': {
                description: 'Base64-encoded x402 settlement receipt.',
                schema: { type: 'string' },
              },
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
            description: 'Bad request — invalid JSON, format, URL count, URL scheme, credentials, or non-public target. Rejected before payment.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          '402': {
            description: 'Payment required ($0.005 USDC on Base mainnet)',
            headers: {
              'X-Request-ID': {
                description: 'Client-generated UUID. Send the same value on the paid retry to correlate the lifecycle.',
                schema: { type: 'string', format: 'uuid' },
              },
              'PAYMENT-REQUIRED': {
                description: 'Base64-encoded x402 v2 payment requirements, including Bazaar discovery metadata.',
                schema: { type: 'string' },
              },
            },
          },
          '500': {
            description: 'Internal server error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
        },
      },
    },
    '/v1/credits/checkout': {
      get: {
        summary: 'Get the prepaid credit package and Stripe Payment Link',
        operationId: 'getCreditCheckout',
        responses: {
          '200': {
            description: 'Reusable Stripe-hosted checkout URL and package terms',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    checkout_url: { type: 'string', format: 'uri' },
                    credit_units: { type: 'integer', example: 10000000 },
                    single_extractions: { type: 'integer', example: 10000 },
                    price_usd: { type: 'number', example: 10 },
                  },
                  required: ['checkout_url', 'credit_units', 'single_extractions', 'price_usd'],
                },
              },
            },
          },
          '503': { description: 'Prepaid checkout is not configured' },
        },
      },
    },
    '/v1/credits/claim': {
      post: {
        summary: 'Bind client-generated API key material to a paid Checkout Session',
        description: 'Generate one API key and submit the same candidate on every retry. The server persists only its hash, making a lost HTTP response safely retryable. The success page handles this automatically.',
        operationId: 'claimCreditCheckout',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  session_id: { type: 'string', pattern: '^cs_', description: 'Stripe Checkout Session ID from the Payment Link redirect' },
                  api_key: { type: 'string', pattern: '^ext_live_[A-Za-z0-9_-]{43}$', description: 'Client-generated 256-bit API key candidate' },
                },
                required: ['session_id', 'api_key'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'The accepted API key candidate and prepaid balance',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    api_key: { type: 'string', description: 'Echoes the accepted candidate; copy it before leaving the success page' },
                    balance_units: { type: 'integer' },
                    single_extractions_remaining: { type: 'integer' },
                    warning: { type: 'string' },
                  },
                  required: ['api_key', 'balance_units', 'single_extractions_remaining', 'warning'],
                },
              },
            },
          },
          '404': { description: 'The paid Checkout Session is not available yet or was reversed' },
          '409': { description: 'The Checkout Session was already claimed with different key material' },
        },
      },
    },
    '/v1/credits/balance': {
      get: {
        summary: 'Read the remaining prepaid balance',
        operationId: 'getCreditBalance',
        security: [{ apiKeyAuth: [] }],
        responses: {
          '200': { description: 'Remaining credit units and equivalent request counts' },
          '401': { description: 'Missing or invalid API key' },
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
        name: 'PAYMENT-SIGNATURE',
        description:
          'x402 v2 signed payment header from an x402-compatible wallet client such as `@x402/fetch`. ' +
          `Single requests authorize $0.001 USDC and batches authorize $0.005 USDC on Base mainnet (\`${NETWORK}\`), payable to \`${PAYMENT_ADDRESS}\`.`,
      },
      apiKeyAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Prepaid Extract API key returned once after Stripe Checkout.',
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
  <meta name="description" content="Interactive API documentation for Extract, the x402 URL-to-markdown API for AI agents." />
  <link rel="canonical" href="https://extract.dkta.dev/docs" />
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

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-labelledby="title">
  <title id="title">Extract</title>
  <rect width="128" height="128" rx="20" fill="#0a0a0a"/>
  <rect x="28" y="52" width="48" height="48" rx="6" fill="none" stroke="#a3e635" stroke-width="8"/>
  <path d="M68 28h32v32M100 28 60 68" fill="none" stroke="#a3e635" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`

app.get('/logo.svg', (_req, res) => {
  res.type('image/svg+xml').send(LOGO_SVG)
})

app.get('/sitemap.xml', (_req, res) => {
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://extract.dkta.dev/</loc></url>
  <url><loc>https://extract.dkta.dev/docs</loc></url>
</urlset>`)
})

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(`User-agent: *
Allow: /
Sitemap: https://extract.dkta.dev/sitemap.xml
`)
})

app.get('/credits/success', (_req, res) => {
  res.setHeader('Cache-Control', 'private, no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"
  )
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>Claim Extract API key</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0a0a; color: #f0f0f0; }
    main { width: min(620px, calc(100% - 32px)); padding: 32px; box-sizing: border-box; background: #111; border: 1px solid #2a2a2a; border-radius: 12px; }
    h1 { margin: 0 0 12px; font-size: 26px; }
    p { color: #aaa; line-height: 1.6; }
    code { display: block; padding: 16px; overflow-wrap: anywhere; background: #0a0a0a; border: 1px solid #2a2a2a; border-radius: 8px; color: #8db6ff; }
    button, a { display: inline-block; margin: 16px 8px 0 0; padding: 10px 14px; border: 0; border-radius: 6px; background: #1a6bff; color: white; text-decoration: none; cursor: pointer; }
    a { background: #292929; }
    .warning { color: #f5a623; }
    .error { color: #ff7b7b; }
  </style>
</head>
<body>
  <main>
    <h1>Claim your Extract API key</h1>
    <p id="status">Confirming your payment…</p>
    <section id="result" hidden>
      <p class="warning">Copy this key now. It is stored only as a hash and cannot be shown again.</p>
      <code id="api-key"></code>
      <button id="copy" type="button">Copy API key</button>
      <a href="/docs">Open API docs</a>
    </section>
  </main>
  <script>
    const status = document.getElementById('status');
    const result = document.getElementById('result');
    const apiKey = document.getElementById('api-key');
    const sessionId = new URLSearchParams(location.search).get('session_id');
    const claimStorageKey = sessionId ? 'extract:claim:' + sessionId : null;
    let candidateApiKey = claimStorageKey ? sessionStorage.getItem(claimStorageKey) : null;
    if (sessionId && !/^ext_live_[A-Za-z0-9_-]{43}$/.test(candidateApiKey || '')) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const token = btoa(String.fromCharCode(...bytes))
        .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      candidateApiKey = 'ext_live_' + token;
      sessionStorage.setItem(claimStorageKey, candidateApiKey);
    }
    async function claim(attempt = 0) {
      if (!sessionId) {
        status.className = 'error';
        status.textContent = 'Missing Checkout Session ID. Use the redirect from Stripe Checkout.';
        return;
      }
      try {
        const response = await fetch('/v1/credits/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId, api_key: candidateApiKey })
        });
        const body = await response.json();
        if (
          attempt < 30 &&
          response.status === 404 && body.code === 'checkout_not_found'
        ) {
          status.textContent = 'Payment received. Preparing your API key…';
          setTimeout(() => claim(attempt + 1), 2000);
          return;
        }
        if (!response.ok) throw new Error(body.error || 'Unable to claim API key');
        apiKey.textContent = body.api_key;
        status.textContent = body.single_extractions_remaining
          ? body.single_extractions_remaining.toLocaleString() + ' single extractions available.'
          : '10,000 single extractions available.';
        result.hidden = false;
      } catch (error) {
        status.className = 'error';
        status.textContent = error.message;
      }
    }
    document.getElementById('copy').addEventListener('click', async event => {
      const button = event.currentTarget;
      await navigator.clipboard.writeText(apiKey.textContent);
      sessionStorage.removeItem(claimStorageKey);
      history.replaceState({}, '', '/credits/success');
      button.textContent = 'Copied';
    });
    claim();
  </script>
</body>
</html>`)
})

app.get('/', (_req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <link rel="icon" type="image/svg+xml" href="/logo.svg">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Extract — URL to clean markdown for AI agents</title>
  <meta name="description" content="Extract clean, LLM-ready markdown from any public URL for $0.001 USDC via x402. No account, API key, subscription, or minimum spend." />
  <link rel="canonical" href="https://extract.dkta.dev/" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://extract.dkta.dev/" />
  <meta property="og:title" content="Extract — URL to clean markdown for AI agents" />
  <meta property="og:description" content="$0.001 USDC per extraction via x402 on Base. No account, API key, or subscription." />
  <meta name="twitter:card" content="summary" />
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"Extract","url":"https://extract.dkta.dev/","applicationCategory":"DeveloperApplication","operatingSystem":"Any","description":"URL-to-clean-markdown API for AI agents with x402 payment on Base.","offers":{"@type":"Offer","price":"0.001","priceCurrency":"USD","description":"Single URL extraction paid in USDC"}}</script>
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
    .prepaid-option {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-5);
      margin-bottom: var(--space-6);
      padding: var(--space-5);
      border: 1px solid var(--border-mid);
      border-radius: var(--radius-md);
      background: var(--bg-code);
    }
    .prepaid-option strong {
      display: block;
      margin-bottom: var(--space-1);
      color: var(--text-primary);
      font-size: 14px;
    }
    .prepaid-option span {
      color: var(--text-tertiary);
      font-size: 12px;
    }
    .prepaid-button {
      flex-shrink: 0;
      padding: 9px 14px;
      border-radius: var(--radius-sm);
      background: var(--accent);
      color: white;
      font-size: 13px;
      font-weight: 500;
      transition: background 0.15s;
    }
    .prepaid-button:hover { background: var(--accent-hover); }
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
      .prepaid-option { flex-direction: column; align-items: flex-start; }
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
        <a href="/docs" class="hide-mobile" data-umami-event="nav-docs">Docs</a>
        <a href="/llms.txt" class="hide-mobile" data-umami-event="nav-llms">/llms.txt</a>
        <a href="/.well-known/ai-plugin.json" class="hide-mobile" data-umami-event="nav-plugin">/ai-plugin.json</a>
        <a href="/docs" class="nav-cta" data-umami-event="nav-try">Try it →</a>
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
              <button class="code-tab active" onclick="switchTab('js', this)" data-umami-event="code-tab" data-umami-event-language="javascript">JavaScript</button>
              <button class="code-tab" onclick="switchTab('curl', this)" data-umami-event="code-tab" data-umami-event-language="curl">curl</button>
              <button class="code-tab" onclick="switchTab('python', this)" data-umami-event="code-tab" data-umami-event-language="python">Python</button>
            </div>
            <button class="copy-btn" onclick="copyCode()" data-umami-event="code-copy">copy</button>
          </div>
          <div class="code-body">

            <div id="pane-js" class="tab-pane active">
<pre><span class="t-comment">// Self-custodied Base wallet; x402 pays and retries automatically</span>
<span class="t-keyword">import</span> { <span class="t-fn">x402Client</span> } <span class="t-keyword">from</span> <span class="t-string">"@x402/core/client"</span>;
<span class="t-keyword">import</span> { <span class="t-fn">registerExactEvmScheme</span> } <span class="t-keyword">from</span> <span class="t-string">"@x402/evm/exact/client"</span>;
<span class="t-keyword">import</span> { <span class="t-fn">wrapFetchWithPayment</span> } <span class="t-keyword">from</span> <span class="t-string">"@x402/fetch"</span>;
<span class="t-keyword">import</span> { <span class="t-fn">privateKeyToAccount</span> } <span class="t-keyword">from</span> <span class="t-string">"viem/accounts"</span>;

<span class="t-keyword">const</span> <span class="t-var">client</span> = <span class="t-keyword">new</span> <span class="t-fn">x402Client</span>();
<span class="t-fn">registerExactEvmScheme</span>(<span class="t-var">client</span>, {
  signer: <span class="t-fn">privateKeyToAccount</span>(process.env.EVM_PRIVATE_KEY)
});
<span class="t-keyword">const</span> <span class="t-var">paidFetch</span> = <span class="t-fn">wrapFetchWithPayment</span>(globalThis.fetch, <span class="t-var">client</span>);
<span class="t-keyword">const</span> <span class="t-var">res</span> = <span class="t-keyword">await</span> <span class="t-fn">paidFetch</span>(
  <span class="t-string">"https://extract.dkta.dev/v1/extract?url=https://example.com&amp;format=markdown"</span>,
  { headers: { <span class="t-string">"X-Request-ID"</span>: globalThis.crypto.<span class="t-fn">randomUUID</span>() } }
);
<span class="t-keyword">const</span> { <span class="t-var">content</span>, <span class="t-var">title</span>, <span class="t-var">word_count</span> } = <span class="t-keyword">await</span> <span class="t-var">res</span>.<span class="t-fn">json</span>();</pre>
            </div>

            <div id="pane-curl" class="tab-pane">
<pre><span class="t-comment"># Verify service health and inspect the payment challenge for free</span>
<span class="t-fn">curl</span> <span class="t-string">"https://extract.dkta.dev/health"</span>
<span class="t-fn">curl</span> <span class="t-var">-i</span> <span class="t-string">"https://extract.dkta.dev/v1/extract?url=https://example.com"</span>

<span class="t-comment"># A compatible x402 v2 client generates the signed payment value</span>
<span class="t-fn">curl</span> <span class="t-string">"https://extract.dkta.dev/v1/extract?url=https://example.com"</span> \\
  -H <span class="t-string">"X-Request-ID: &lt;same-uuid&gt;"</span> \\
  -H <span class="t-string">"PAYMENT-SIGNATURE: &lt;signed-payment&gt;"</span></pre>
            </div>

            <div id="pane-python" class="tab-pane">
<pre><span class="t-keyword">import</span> os
<span class="t-keyword">from</span> eth_account <span class="t-keyword">import</span> Account
<span class="t-keyword">from</span> x402 <span class="t-keyword">import</span> x402ClientSync
<span class="t-keyword">from</span> x402.http.clients <span class="t-keyword">import</span> x402_requests
<span class="t-keyword">from</span> x402.mechanisms.evm <span class="t-keyword">import</span> EthAccountSigner
<span class="t-keyword">from</span> x402.mechanisms.evm.exact.register <span class="t-keyword">import</span> register_exact_evm_client

<span class="t-var">client</span> = <span class="t-fn">x402ClientSync</span>()
<span class="t-fn">register_exact_evm_client</span>(
    <span class="t-var">client</span>,
    <span class="t-fn">EthAccountSigner</span>(Account.<span class="t-fn">from_key</span>(os.environ[<span class="t-string">"EVM_PRIVATE_KEY"</span>]))
)
<span class="t-keyword">with</span> <span class="t-fn">x402_requests</span>(<span class="t-var">client</span>) <span class="t-keyword">as</span> <span class="t-var">session</span>:
    <span class="t-var">res</span> = <span class="t-var">session</span>.<span class="t-fn">get</span>(
        <span class="t-string">"https://extract.dkta.dev/v1/extract"</span>,
        params={<span class="t-string">"url"</span>: <span class="t-string">"https://example.com"</span>},
    )
    <span class="t-fn">print</span>(<span class="t-var">res</span>.<span class="t-fn">json</span>()[<span class="t-string">"content"</span>])</pre>
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
          Input validated before payment
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
          <p>The API returns clean, LLM-ready content stripped of nav, ads, and boilerplate. Single-request 4xx/5xx failures are not settled. A batch settles on its 200 response, including any per-URL errors returned inline.</p>
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

<span class="t-comment">PAYMENT-SIGNATURE: &lt;x402-proof&gt;
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
  <span class="t-prop">"byline"</span>: <span class="t-keyword">null</span>,
  <span class="t-prop">"url"</span>: <span class="t-string">"https://en.wikipedia.org/wiki/Markdown"</span>,
  <span class="t-prop">"content"</span>: <span class="t-string">"# Markdown\\n\\nMarkdown is a lightweight markup language..."</span>,
  <span class="t-prop">"length"</span>: <span class="t-num">4821</span>,
  <span class="t-prop">"word_count"</span>: <span class="t-num">800</span>,
  <span class="t-prop">"extraction_method"</span>: <span class="t-string">"crawl4ai"</span>,
  <span class="t-prop">"lang"</span>: <span class="t-string">"en"</span>
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
      <p class="section-sub">Pay per request with x402, or buy an optional $10 prepaid API key by card. No account or subscription.</p>
      <div class="pricing-card">
        <div class="price-display">
          <span class="price-amount">$0.001</span>
          <span class="price-unit">USDC</span>
        </div>
        <p class="price-per">per single request &nbsp;·&nbsp; <span class="price-math">$0.005 per batch of 1–5 URLs</span> &nbsp;·&nbsp; <span class="price-math">$1.00 = 1,000 single requests</span></p>

        <div class="pricing-details">
          <div class="pricing-detail"><span class="check">✓</span> No account required</div>
          <div class="pricing-detail"><span class="check">✓</span> No subscription</div>
          <div class="pricing-detail"><span class="check">✓</span> x402 has no minimum spend</div>
          <div class="pricing-detail"><span class="check">✓</span> Input checked before charging</div>
          <div class="pricing-detail"><span class="check">✓</span> Wallet path needs no API key</div>
          <div class="pricing-detail"><span class="check">✓</span> Optional card-funded API key</div>
        </div>

        ${creditService ? `
        <div class="prepaid-option">
          <div>
            <strong>Pay by card, use an API key</strong>
            <span>$10 prepays 10,000 single requests. The key is shown once after checkout.</span>
          </div>
          <a class="prepaid-button" href="${creditService.checkout.checkoutUrl}" rel="noreferrer" data-umami-event="prepaid-checkout">Buy credits →</a>
        </div>
        ` : ''}

        <div class="pricing-chain">
          <div class="chain-logo">
            <div class="chain-dot"></div>
            Paid via x402 on Base or Stripe-hosted prepaid checkout
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
        <a href="/docs" class="agent-link-card" data-umami-event="discovery-docs">
          <div class="agent-link-path">/docs</div>
          <div class="agent-link-desc">Interactive API explorer. OpenAPI spec with live request testing.</div>
          <div class="agent-link-arrow">→</div>
        </a>
        <a href="/llms.txt" class="agent-link-card" data-umami-event="discovery-llms">
          <div class="agent-link-path">/llms.txt</div>
          <div class="agent-link-desc">Plain-text API description for direct LLM consumption. Paste into any context window.</div>
          <div class="agent-link-arrow">→</div>
        </a>
        <a href="/.well-known/ai-plugin.json" class="agent-link-card" data-umami-event="discovery-plugin">
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
          <a href="/docs" data-umami-event="footer-docs">API Docs</a>
          <a href="/llms.txt" data-umami-event="footer-llms">/llms.txt</a>
          <a href="/.well-known/ai-plugin.json" data-umami-event="footer-plugin">ai-plugin.json</a>
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
  res.type('text/plain').sendFile(path.join(process.cwd(), 'public', 'llms.txt'))
})

// Well-known ai-plugin.json for agent autodiscovery
app.get('/.well-known/ai-plugin.json', (_req, res) => {
  res.json({
    schema_version: 'v1',
    name_for_human: 'extract.dkta.dev',
    name_for_model: 'extract',
    description_for_human: 'Extract clean markdown or text from public URLs. Pay $0.001 USDC per single call via x402 on Base.',
    description_for_model: 'Extracts clean readable content (markdown or plain text) from public URLs using Crawl4AI with a Readability fallback. Requires x402 micropayment of $0.001 USDC on Base mainnet. Use GET /v1/extract?url=<url>&format=markdown',
    auth: { type: 'none' },
    api: { type: 'openapi', url: 'https://extract.dkta.dev/openapi.json' },
    logo_url: 'https://extract.dkta.dev/logo.svg',
    contact_email: 'hi@dkta.dev',
    legal_info_url: 'https://dkta.dev',
  })
})

// Well-known x402.json for agent framework autodiscovery
const x402Manifest = {
  version: '2',
  x402Version: 2,
  endpoints: [
    {
      path: '/v1/extract',
      method: 'GET',
      network: 'eip155:8453',
      asset: 'USDC',
      description: 'Extract clean, LLM-ready markdown from a public URL for $0.001 USDC.',
    },
    {
      path: '/v1/extract/batch',
      method: 'POST',
      network: 'eip155:8453',
      asset: 'USDC',
      description: 'Batch extract 1 to 5 public URLs for a flat $0.005 USDC.',
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

function shutdown() {
  server.close(() => {
    creditService?.close()
    process.exit(0)
  })
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
