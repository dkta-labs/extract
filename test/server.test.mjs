import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { paymentMiddleware, x402ResourceServer } from '@x402/express'
import { HTTPFacilitatorClient } from '@x402/core/server'
import { registerExactEvmScheme } from '@x402/evm/exact/server'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAYMENT_ADDRESS = '0x9C924E0b95FBE2Fe69D6ecDb434AEBFa15E236b2'
const PAYER_ADDRESS = '0x1111111111111111111111111111111111111111'
const SETTLEMENT_TRANSACTION = `0x${'2'.repeat(64)}`
const NETWORK = 'eip155:8453'
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

let analyticsServer
let analyticsUrl
let facilitatorServer
let facilitatorUrl
let crawlerServer
let crawlerUrl
let targetServer
let targetPort
let app
let baseUrl
let workDir
const analyticsEvents = []
const facilitatorCalls = []

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address()))
  })
}

function close(server) {
  return new Promise(resolve => server.close(resolve))
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function paymentRequired(response) {
  const encodedChallenge = response.headers.get('payment-required')
  assert.ok(encodedChallenge)
  return JSON.parse(Buffer.from(encodedChallenge, 'base64').toString())
}

async function paymentHeader(url, requestOptions = {}, signature = '0x01') {
  const response = await fetch(url, requestOptions)
  assert.equal(response.status, 402)
  const challenge = paymentRequired(response)
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    resource: challenge.resource,
    accepted: challenge.accepts[0],
    payload: {
      signature,
      authorization: {
        from: PAYER_ADDRESS,
        to: challenge.accepts[0].payTo,
        value: challenge.accepts[0].amount,
        validAfter: '0',
        validBefore: '9999999999',
        nonce: `0x${'0'.repeat(64)}`,
      },
    },
    extensions: challenge.extensions,
  })).toString('base64')
}

async function waitForEvent(name, requestId) {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const match = analyticsEvents.find(event =>
      event.body?.payload?.name === name && event.body?.payload?.data?.request_id === requestId
    )
    if (match) return match
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`analytics event ${name} for ${requestId} was not received`)
}

before(async () => {
  analyticsServer = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      analyticsEvents.push({
        body: JSON.parse(raw),
        userAgent: req.headers['user-agent'],
      })
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        cache: 'test',
        sessionId: '00000000-0000-4000-8000-000000000000',
        visitId: '00000000-0000-4000-8000-000000000001',
      }))
    })
  })
  const analyticsAddress = await listen(analyticsServer)
  analyticsUrl = `http://127.0.0.1:${analyticsAddress.port}/api/send`

  facilitatorServer = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null
      facilitatorCalls.push({ path: req.url, body })
      if (req.url === '/supported') {
        return sendJson(res, 200, {
          kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }],
          extensions: ['bazaar'],
          signers: {},
        })
      }
      if (req.url === '/verify') {
        return sendJson(res, 200, { isValid: true, payer: PAYER_ADDRESS })
      }
      if (req.url === '/settle') {
        if (body.paymentPayload.payload.signature === '0xdead') {
          return sendJson(res, 200, {
            success: false,
            errorReason: 'invalid_payment',
            payer: PAYER_ADDRESS,
            transaction: '',
            network: NETWORK,
          })
        }
        return sendJson(res, 200, {
          success: true,
          payer: PAYER_ADDRESS,
          transaction: SETTLEMENT_TRANSACTION,
          network: NETWORK,
        })
      }
      return sendJson(res, 404, { error: 'not found' })
    })
  })
  const facilitatorAddress = await listen(facilitatorServer)
  facilitatorUrl = `http://127.0.0.1:${facilitatorAddress.port}`

  targetServer = createServer(req => req.socket.destroy())
  const targetAddress = await listen(targetServer)
  targetPort = targetAddress.port

  crawlerServer = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const { url } = JSON.parse(raw)
      if (new URL(url).port === String(targetPort)) {
        return sendJson(res, 200, { markdown: '' })
      }
      return sendJson(res, 200, {
        markdown: '# Paid extraction\n\nDeterministic integration content.',
        metadata: { title: 'Paid extraction' },
      })
    })
  })
  const crawlerAddress = await listen(crawlerServer)
  crawlerUrl = `http://127.0.0.1:${crawlerAddress.port}/md`

  const portProbe = createServer()
  const appAddress = await listen(portProbe)
  await close(portProbe)
  baseUrl = `http://127.0.0.1:${appAddress.port}`
  workDir = await mkdtemp(path.join(tmpdir(), 'extract-test-'))

  app = spawn(process.execPath, ['--import', './test/local-public-target.mjs', 'index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(appAddress.port),
      PAYMENT_ADDRESS,
      NETWORK,
      LOG_PATH: path.join(workDir, 'requests.jsonl'),
      UMAMI_URL: analyticsUrl,
      FACILITATOR_URL: facilitatorUrl,
      CRAWL4AI_URL: crawlerUrl,
      TEST_PUBLIC_TARGET_PORT: String(targetPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`server readiness timed out: ${output}`)), 10000)
    app.stdout.on('data', chunk => {
      output += chunk
      if (output.includes('extract API running')) {
        clearTimeout(timer)
        resolve()
      }
    })
    app.stderr.on('data', chunk => { output += chunk })
    app.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`server exited before readiness with code ${code}: ${output}`))
    })
  })
})

after(async () => {
  if (app && app.exitCode === null) {
    app.kill('SIGTERM')
    await new Promise(resolve => app.once('exit', resolve))
  }
  if (analyticsServer) await close(analyticsServer)
  if (facilitatorServer) await close(facilitatorServer)
  if (crawlerServer) await close(crawlerServer)
  if (targetServer) await close(targetServer)
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

test('serves healthy discovery and truthful public contracts', async () => {
  const health = await fetch(`${baseUrl}/health`)
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { ok: true })

  for (const route of ['/logo.svg', '/sitemap.xml', '/robots.txt', '/docs']) {
    const response = await fetch(`${baseUrl}${route}`)
    assert.equal(response.status, 200, route)
  }

  const landing = await (await fetch(baseUrl)).text()
  assert.match(landing, /word_count/)
  assert.doesNotMatch(landing, /charged_usdc/)
  assert.doesNotMatch(landing, /Payment settles before extraction/)
  assert.match(landing, /Single-request 4xx\/5xx failures are not settled/)

  const spec = await (await fetch(`${baseUrl}/openapi.json`)).json()
  assert.equal(spec.info.version, '2.0.0')
  assert.equal(spec.components.securitySchemes.x402Payment.description.includes(PAYMENT_ADDRESS), true)
  assert.equal(JSON.stringify(spec).includes('X-RateLimit-Limit'), false)
  assert.equal(spec.paths['/v1/extract'].get.parameters.at(-1).schema.format, 'uuid')
  assert.equal(spec.paths['/v1/extract/batch'].post.parameters[0].schema.format, 'uuid')
  assert.equal(spec.paths['/v1/extract'].get.responses['402'].headers['X-Request-ID'].schema.format, 'uuid')
  assert.equal(spec.paths['/v1/extract/batch'].post.responses['402'].headers['X-Request-ID'].schema.format, 'uuid')
  assert.equal(spec.paths['/v1/extract'].get.responses['200'].headers['PAYMENT-RESPONSE'].schema.type, 'string')
  assert.equal(spec.paths['/v1/extract/batch'].post.responses['200'].headers['PAYMENT-RESPONSE'].schema.type, 'string')
  assert.deepEqual(
    spec.paths['/v1/extract'].get.responses['200'].content['application/json'].schema.required,
    ['title', 'byline', 'url', 'content', 'length', 'word_count', 'extraction_method', 'lang']
  )
})

test('rejects invalid and non-public targets before payment', async t => {
  const cases = [
    ['/v1/extract', 'url must be a string'],
    ['/v1/extract?url=file%3A%2F%2F%2Fetc%2Fpasswd', 'url must use http or https'],
    ['/v1/extract?url=http%3A%2F%2Flocalhost', 'not publicly routable'],
    ['/v1/extract?url=http%3A%2F%2F127.0.0.1', 'not publicly routable'],
    ['/v1/extract?url=http%3A%2F%2F169.254.169.254', 'not publicly routable'],
    ['/v1/extract?url=http%3A%2F%2F%5B%3A%3A1%5D', 'not publicly routable'],
    ['/v1/extract?url=http%3A%2F%2F%5B%3A%3Affff%3A127.0.0.1%5D', 'not publicly routable'],
    ['/v1/extract?url=http%3A%2F%2F%5Bfec0%3A%3A1%5D', 'not publicly routable'],
  ]

  for (const [route, message] of cases) {
    await t.test(route, async () => {
      const response = await fetch(`${baseUrl}${route}`)
      assert.equal(response.status, 400)
      assert.match((await response.json()).error, new RegExp(message))
    })
  }

  const batch = await fetch(`${baseUrl}/v1/extract/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: ['https://1.1.1.1', 'http://10.0.0.1'] }),
  })
  assert.equal(batch.status, 400)
  assert.match((await batch.json()).error, /invalid url at index 1/)
})

test('returns priced challenges and echoes client attempt IDs', async () => {
  const singleId = '63c9ea8f-b170-4fae-bf67-7dba572c18ba'
  const single = await fetch(`${baseUrl}/v1/extract?url=https%3A%2F%2F1.1.1.1`, {
    headers: { 'X-Request-ID': singleId },
  })
  assert.equal(single.status, 402)
  assert.equal(single.headers.get('x-request-id'), singleId)
  assert.equal(single.headers.get('cache-control'), 'private, no-store')
  const singleChallenge = paymentRequired(single)
  assert.equal(singleChallenge.x402Version, 2)
  assert.equal(singleChallenge.accepts[0].amount, '1000')
  assert.equal(singleChallenge.accepts[0].network, NETWORK)
  assert.equal(singleChallenge.accepts[0].asset, USDC_ADDRESS)
  assert.equal(singleChallenge.accepts[0].payTo, PAYMENT_ADDRESS)
  assert.equal(singleChallenge.extensions.bazaar.info.input.method, 'GET')
  assert.equal(singleChallenge.extensions.bazaar.info.input.queryParams.url, 'https://example.com/article')

  const singleEvent = await waitForEvent('payment-challenge', singleId)
  assert.match(singleEvent.userAgent, /Chrome\/138/)
  assert.equal(singleEvent.body.type, 'event')
  assert.equal(singleEvent.body.payload.url, '/v1/extract')

  const batchId = '0ebf078d-45cc-4e90-b369-adbf60f33aeb'
  const batch = await fetch(`${baseUrl}/v1/extract/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': batchId },
    body: JSON.stringify({ urls: ['https://1.1.1.1'] }),
  })
  assert.equal(batch.status, 402)
  assert.equal(batch.headers.get('x-request-id'), batchId)
  const batchChallenge = paymentRequired(batch)
  assert.equal(batchChallenge.accepts[0].amount, '5000')
  assert.equal(batchChallenge.extensions.bazaar.info.input.method, 'POST')
  assert.deepEqual(batchChallenge.extensions.bazaar.info.input.body.urls, ['https://example.com/article'])
  await waitForEvent('payment-challenge', batchId)
  const variantId = '72903f76-6f06-4ae5-a6a4-8cbcaa463ae0'
  const routeVariant = await fetch(`${baseUrl}/V1/EXTRACT/?url=https%3A%2F%2F1.1.1.1`, {
    headers: { 'X-Request-ID': variantId },
  })
  assert.equal(routeVariant.status, 402)
  assert.equal(routeVariant.headers.get('x-request-id'), variantId)
  assert.equal((await waitForEvent('payment-challenge', variantId)).body.payload.url, '/v1/extract')

  const replaced = await fetch(`${baseUrl}/v1/extract?url=https%3A%2F%2F1.1.1.1`, {
    headers: { 'X-Request-ID': 'not-a-uuid' },
  })
  const replacementId = replaced.headers.get('x-request-id')
  assert.notEqual(replacementId, 'not-a-uuid')
  assert.match(replacementId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
})

test('tracks successful settlement and skips settlement for failed responses', async () => {
  const successId = '614ce52b-b967-4c05-910c-c1ea8228004e'
  const extractUrl = `${baseUrl}/v1/extract?url=https%3A%2F%2F1.1.1.1`
  const successPayment = await paymentHeader(extractUrl, {
    headers: { 'X-Request-ID': successId },
  })
  const success = await fetch(extractUrl, {
    headers: {
      'X-Request-ID': successId,
      'PAYMENT-SIGNATURE': successPayment,
    },
  })
  assert.equal(success.status, 200)
  assert.match((await success.json()).content, /Deterministic integration content/)
  const responseHeader = success.headers.get('payment-response')
  assert.ok(responseHeader)
  assert.equal(JSON.parse(Buffer.from(responseHeader, 'base64').toString()).success, true)
  await waitForEvent('payment-authorized', successId)
  await waitForEvent('payment-settled', successId)

  const failedSettlementId = 'c3b67bbd-60f6-4db9-88d5-50686d421175'
  const failedPayment = await paymentHeader(extractUrl, {
    headers: { 'X-Request-ID': failedSettlementId },
  }, '0xdead')
  const failedSettlement = await fetch(extractUrl, {
    headers: {
      'X-Request-ID': failedSettlementId,
      'PAYMENT-SIGNATURE': failedPayment,
    },
  })
  assert.equal(failedSettlement.status, 402)
  const failedSettlementHeader = failedSettlement.headers.get('payment-response')
  assert.ok(failedSettlementHeader)
  assert.equal(JSON.parse(Buffer.from(failedSettlementHeader, 'base64').toString()).success, false)
  await waitForEvent('payment-authorized', failedSettlementId)
  await waitForEvent('payment-challenge', failedSettlementId)
  assert.equal(analyticsEvents.some(event =>
    event.body?.payload?.name === 'payment-settled' &&
    event.body?.payload?.data?.request_id === failedSettlementId
  ), false)

  const failureApp = express()
  const failureResourceServer = new x402ResourceServer(
    new HTTPFacilitatorClient({ url: facilitatorUrl })
  )
  registerExactEvmScheme(failureResourceServer, { networks: [NETWORK] })
  failureApp.use(paymentMiddleware({
    'GET /failure': {
      accepts: {
        scheme: 'exact',
        price: '$0.001',
        network: NETWORK,
        payTo: PAYMENT_ADDRESS,
        maxTimeoutSeconds: 60,
      },
      description: 'Test failed response',
      mimeType: 'application/json',
    },
  }, failureResourceServer))
  failureApp.get('/failure', (_req, res) => res.status(502).json({ error: 'upstream failed' }))
  const failureServer = createServer(failureApp)
  const failureAddress = await listen(failureServer)
  const failureUrl = `http://127.0.0.1:${failureAddress.port}/failure`
  const settlementsBeforeFailure = facilitatorCalls.filter(call => call.path === '/settle').length
  try {
    const failurePayment = await paymentHeader(failureUrl, {}, '0x03')
    const failure = await fetch(failureUrl, {
      headers: { 'PAYMENT-SIGNATURE': failurePayment },
    })
    assert.equal(failure.status, 502)
    assert.equal(failure.headers.get('payment-response'), null)
    assert.equal(facilitatorCalls.filter(call => call.path === '/settle').length, settlementsBeforeFailure)
  } finally {
    await close(failureServer)
  }
})

test('records a normalized single hostname without URL secrets', async () => {
  const requestId = '4456d5b9-b4ad-46cc-8d84-7a0c5e526489'
  const secrets = ['single-path-secret', 'single-query-secret', 'single-fragment-secret']
  const target = `https://EXAMPLE.COM/${secrets[0]}?token=${secrets[1]}#${secrets[2]}`
  const requestUrl = `${baseUrl}/v1/extract?url=${encodeURIComponent(target)}&format=text`
  const payment = await paymentHeader(requestUrl, {
    headers: { 'X-Request-ID': requestId },
  }, '0x04')
  const response = await fetch(requestUrl, {
    headers: {
      'X-Request-ID': requestId,
      'PAYMENT-SIGNATURE': payment,
    },
  })
  assert.equal(response.status, 200)
  await response.json()

  const analytics = (await waitForEvent('extract-request', requestId)).body.payload.data
  assert.deepEqual(Object.keys(analytics).sort(), [
    'duration_ms', 'format', 'length', 'request_id', 'status', 'target_hostname',
  ])
  assert.equal(analytics.target_hostname, 'example.com')
  assert.equal(analytics.request_id, requestId)

  const entries = (await readFile(path.join(workDir, 'requests.jsonl'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line))
  const logged = entries.find(entry => entry.event === 'success' && entry.request_id === requestId)
  assert.ok(logged)
  assert.deepEqual(Object.keys(logged).sort(), [
    'duration_ms', 'endpoint', 'event', 'format', 'length', 'request_id', 'target_hostname', 'ts',
  ])
  assert.equal(logged.target_hostname, 'example.com')

  const telemetry = JSON.stringify({ analytics, logged })
  for (const secret of secrets) assert.doesNotMatch(telemetry, new RegExp(secret))
})

test('records a paid single failure hostname without URL secrets', async () => {
  const requestId = 'f6be8e83-6ea1-4e3d-a4c7-f019f1e99df6'
  const secrets = ['failure-path-secret', 'failure-query-secret', 'failure-fragment-secret']
  const target = `http://EXAMPLE.COM:${targetPort}/${secrets[0]}?token=${secrets[1]}#${secrets[2]}`
  const requestUrl = `${baseUrl}/v1/extract?url=${encodeURIComponent(target)}&format=text`
  const payment = await paymentHeader(requestUrl, {
    headers: { 'X-Request-ID': requestId },
  }, '0x06')
  const response = await fetch(requestUrl, {
    headers: {
      'X-Request-ID': requestId,
      'PAYMENT-SIGNATURE': payment,
    },
  })
  assert.equal(response.status, 500)
  await response.json()
  await waitForEvent('payment-authorized', requestId)

  const analytics = (await waitForEvent('extract-request', requestId)).body.payload.data
  assert.deepEqual(Object.keys(analytics).sort(), [
    'duration_ms', 'format', 'reason', 'request_id', 'status', 'target_hostname',
  ])
  assert.equal(analytics.target_hostname, 'example.com')
  assert.equal(analytics.request_id, requestId)
  assert.equal(analytics.status, 500)
  assert.equal(analytics.reason, 'internal_error')
  assert.equal(analytics.format, 'text')
  assert.equal(typeof analytics.duration_ms, 'number')

  const entries = (await readFile(path.join(workDir, 'requests.jsonl'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line))
  const logged = entries.find(entry => entry.event === 'failure' && entry.request_id === requestId)
  assert.ok(logged)
  assert.deepEqual(Object.keys(logged).sort(), [
    'duration_ms', 'endpoint', 'event', 'format', 'reason', 'request_id', 'status',
    'target_hostname', 'ts',
  ])
  assert.equal(logged.target_hostname, analytics.target_hostname)
  assert.equal(logged.endpoint, '/v1/extract')
  assert.equal(logged.status, analytics.status)
  assert.equal(logged.reason, analytics.reason)
  assert.equal(logged.format, analytics.format)
  assert.equal(typeof logged.duration_ms, 'number')

  const telemetry = JSON.stringify({ analytics, logged })
  for (const secret of secrets) assert.doesNotMatch(telemetry, new RegExp(secret))
})

test('records bounded batch hostnames aligned with outcomes without URL secrets', async () => {
  const requestId = '7dc79fbe-9f9b-40e5-9db1-f021445dfb7e'
  const secrets = [
    'batch-path-one-secret',
    'batch-query-one-secret',
    'batch-fragment-one-secret',
    'batch-path-two-secret',
    'batch-query-two-secret',
    'batch-fragment-two-secret',
  ]
  const targets = [
    `https://EXAMPLE.COM/${secrets[0]}?token=${secrets[1]}#${secrets[2]}`,
    `https://EXAMPLE.ORG/${secrets[3]}?token=${secrets[4]}#${secrets[5]}`,
  ]
  const requestUrl = `${baseUrl}/v1/extract/batch`
  const requestBody = JSON.stringify({ urls: targets, format: 'markdown' })
  const requestOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': requestId,
    },
    body: requestBody,
  }
  const payment = await paymentHeader(requestUrl, requestOptions, '0x05')
  const response = await fetch(requestUrl, {
    ...requestOptions,
    headers: {
      ...requestOptions.headers,
      'PAYMENT-SIGNATURE': payment,
    },
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).results.length, 2)

  const analytics = (await waitForEvent('extract-batch', requestId)).body.payload.data
  assert.deepEqual(Object.keys(analytics).sort(), [
    'count', 'duration_ms', 'failure_count', 'format', 'request_id', 'status',
    'target_hostname_1', 'target_hostname_2', 'target_outcome_1', 'target_outcome_2',
  ])
  assert.deepEqual(
    [analytics.target_hostname_1, analytics.target_outcome_1, analytics.target_hostname_2, analytics.target_outcome_2],
    ['example.com', 'success', 'example.org', 'success']
  )
  assert.equal(Object.values(analytics).every(value => ['number', 'string'].includes(typeof value)), true)

  const settlement = (await waitForEvent('payment-settled', requestId)).body.payload.data
  assert.equal(settlement.endpoint, '/v1/extract/batch')
  const entries = (await readFile(path.join(workDir, 'requests.jsonl'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line))
  const logged = entries.find(entry => entry.event === 'success' && entry.request_id === requestId)
  assert.ok(logged)
  assert.deepEqual(Object.keys(logged).sort(), [
    'count', 'duration_ms', 'endpoint', 'event', 'failure_count', 'format', 'request_id',
    'target_hostname_1', 'target_hostname_2', 'target_outcome_1', 'target_outcome_2', 'ts',
  ])
  assert.deepEqual(
    [logged.target_hostname_1, logged.target_outcome_1, logged.target_hostname_2, logged.target_outcome_2],
    ['example.com', 'success', 'example.org', 'success']
  )

  const telemetry = JSON.stringify({ analytics, logged, settlement })
  for (const secret of secrets) assert.doesNotMatch(telemetry, new RegExp(secret))
})

test('keeps request logs free of full target URLs and client IP fields', async () => {
  const log = await readFile(path.join(workDir, 'requests.jsonl'), 'utf8')
  const entries = log.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(entries.length > 0, true)
  for (const entry of entries) {
    assert.equal('url' in entry, false)
    assert.equal('ip' in entry, false)
  }
  assert.doesNotMatch(log, /https?:\/\//)
})
