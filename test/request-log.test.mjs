import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  REQUEST_LOG_MAX_BYTES,
  REQUEST_LOG_MAINTENANCE_INTERVAL_MS,
  REQUEST_LOG_RETENTION_MS,
  stripExpiredHostnameFieldsFromFile,
  stripExpiredHostnameFields,
  startRequestLogMaintenance,
} from '../request-log.js'

const NOW = Date.parse('2026-07-30T12:00:00.000Z')
const CUTOFF = NOW - REQUEST_LOG_RETENTION_MS
const TARGET_HOSTNAME_FIELDS = [
  'target_hostname',
  'target_hostname_1',
  'target_hostname_2',
  'target_hostname_3',
  'target_hostname_4',
  'target_hostname_5',
]

function withoutTargetHostnames(entry) {
  const result = { ...entry }
  for (const field of TARGET_HOSTNAME_FIELDS) delete result[field]
  return result
}

function logEntry(timestamp, label, fields = {}) {
  return {
    ts: new Date(timestamp).toISOString(),
    event: 'success',
    request_id: `request-${label}`,
    endpoint: '/v1/extract/batch',
    settlement_status: 'settled',
    count: 5,
    failure_count: 2,
    format: 'markdown',
    duration_ms: 123,
    length: 456,
    input_length: 789,
    output_length: 321,
    label,
    ...fields,
  }
}

function line(entry) {
  return JSON.stringify(entry)
}

async function temporaryLog(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'extract-request-log-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return path.join(directory, 'requests.jsonl')
}

async function entries(filePath) {
  const contents = await readFile(filePath, 'utf8')
  if (contents === '') return []
  return contents.trimEnd().split('\n').map(entry => JSON.parse(entry))
}

async function waitFor(check) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('periodic request-log hostname retention timed out')
}

test('strips only old hostname fields at startup across active and rotated logs', async t => {
  const logPath = await temporaryLog(t)
  const outcomeFields = Object.fromEntries(
    Array.from({ length: 5 }, (_, index) => [`target_outcome_${index + 1}`, index % 2 ? 'failure' : 'success'])
  )
  const hostnameDimensions = Object.fromEntries(
    TARGET_HOSTNAME_FIELDS.map((field, index) => [field, `old-${index}.example`])
  )
  const activeOld = logEntry(CUTOFF - 1, 'active-old', {
    ...hostnameDimensions,
    ...outcomeFields,
    operational_correlation: 'keep-active',
    target_hostname_6: 'non-retained-dimension.example',
  })
  const activeBoundary = logEntry(CUTOFF, 'active-boundary', {
    target_hostname: 'boundary.example',
    target_outcome_1: 'success',
  })
  const activeRecent = logEntry(CUTOFF + 1, 'active-recent', {
    target_hostname: 'recent.example',
  })
  const rotatedOld = logEntry(CUTOFF - 1, 'rotated-old', {
    target_hostname_1: 'rotated-old.example',
    target_outcome_1: 'failure',
    payment_correlation: 'keep-rotated',
  })
  const rotatedRecent = logEntry(NOW, 'rotated-recent', {
    target_hostname_1: 'rotated-recent.example',
    target_outcome_1: 'success',
  })
  await writeFile(logPath, [activeOld, activeBoundary, activeRecent].map(line).join('\n') + '\n')
  await writeFile(`${logPath}.1`, [rotatedOld, rotatedRecent].map(line).join('\n') + '\n')

  const timer = startRequestLogMaintenance(logPath, {
    now: () => NOW,
    intervalMs: REQUEST_LOG_MAINTENANCE_INTERVAL_MS,
  })
  clearInterval(timer)

  const active = await entries(logPath)
  const rotated = await entries(`${logPath}.1`)
  const expectedActiveOld = withoutTargetHostnames(activeOld)
  const expectedActiveBoundary = withoutTargetHostnames(activeBoundary)
  const expectedRotatedOld = withoutTargetHostnames(rotatedOld)

  assert.equal(REQUEST_LOG_RETENTION_MS, 166 * 60 * 60 * 1000)
  assert.equal(REQUEST_LOG_MAINTENANCE_INTERVAL_MS, 60 * 60 * 1000)
  assert.equal(active.length, 3)
  assert.equal(rotated.length, 2)
  assert.deepEqual(active[0], expectedActiveOld)
  assert.deepEqual(active[1], expectedActiveBoundary)
  assert.deepEqual(active[2], activeRecent)
  assert.deepEqual(rotated[0], expectedRotatedOld)
  assert.deepEqual(rotated[1], rotatedRecent)
  assert.deepEqual(
    Object.fromEntries(Object.entries(active[0]).filter(([field]) => field.startsWith('target_outcome_'))),
    outcomeFields
  )
})

test('periodically strips old hostnames without removing request records', async t => {
  const logPath = await temporaryLog(t)
  await writeFile(logPath, `${line(logEntry(Date.now(), 'startup-active-recent'))}\n`)
  await writeFile(`${logPath}.1`, `${line(logEntry(Date.now(), 'startup-rotated-recent'))}\n`)
  const timer = startRequestLogMaintenance(logPath, { intervalMs: 20 })
  t.after(() => clearInterval(timer))

  const activeOld = logEntry(Date.now() - REQUEST_LOG_RETENTION_MS - 1000, 'periodic-active-old', {
    target_hostname: 'active-old.example',
    target_outcome_1: 'failure',
  })
  const activeRecent = logEntry(Date.now(), 'periodic-active-recent', {
    target_hostname: 'active-recent.example',
  })
  const rotatedOld = logEntry(Date.now() - REQUEST_LOG_RETENTION_MS - 1000, 'periodic-rotated-old', {
    target_hostname_1: 'rotated-old.example',
    target_outcome_1: 'success',
  })
  const rotatedRecent = logEntry(Date.now(), 'periodic-rotated-recent', {
    target_hostname_1: 'rotated-recent.example',
  })
  fs.writeFileSync(logPath, [activeOld, activeRecent].map(line).join('\n') + '\n')
  fs.writeFileSync(`${logPath}.1`, [rotatedOld, rotatedRecent].map(line).join('\n') + '\n')

  await waitFor(async () => {
    const active = await entries(logPath)
    const rotated = await entries(`${logPath}.1`)
    return active.length === 2 &&
      !Object.hasOwn(active[0], 'target_hostname') &&
      active[0].target_outcome_1 === 'failure' &&
      active[1].target_hostname === 'active-recent.example' &&
      rotated.length === 2 &&
      !Object.hasOwn(rotated[0], 'target_hostname_1') &&
      rotated[0].target_outcome_1 === 'success' &&
      rotated[1].target_hostname_1 === 'rotated-recent.example'
  })
})

test('drops unageable records while retaining safe request evidence', async t => {
  const logPath = await temporaryLog(t)
  const cases = [
    '{not-json}',
    JSON.stringify({ ts: 'not-a-timestamp', target_hostname: 'unknown-age.example' }),
  ]

  for (const [index, malformed] of cases.entries()) {
    const old = logEntry(CUTOFF - 1, `old-${index}`, {
      target_hostname: 'strip-from-old.example',
    })
    const recent = logEntry(NOW, `recent-${index}`, {
      target_hostname: 'recent.example',
    })
    const safeUnageable = {
      event: 'payment_challenge',
      request_id: `safe-unageable-${index}`,
      endpoint: '/v1/extract',
    }
    const rotatedOld = logEntry(CUTOFF - 1, `rotated-old-${index}`, {
      target_hostname: 'strip-from-valid-file.example',
      target_outcome_1: 'failure',
    })
    await writeFile(logPath, [line(old), malformed, line(safeUnageable), line(recent)].join('\n') + '\n')
    await writeFile(`${logPath}.1`, `${line(rotatedOld)}\n`)

    const warnings = []
    const originalWarn = console.warn
    console.warn = message => warnings.push(message)
    try {
      assert.equal(stripExpiredHostnameFields(logPath, NOW), true)
    } finally {
      console.warn = originalWarn
    }

    assert.deepEqual(
      await entries(logPath),
      [withoutTargetHostnames(old), safeUnageable, recent]
    )
    assert.deepEqual(
      await entries(`${logPath}.1`),
      [withoutTargetHostnames(rotatedOld)]
    )
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /dropped 1 unageable record.*requests\.jsonl/)
  }
})

test('keeps the original log when atomic replacement cannot be written', async t => {
  const logPath = await temporaryLog(t)
  const original = [
    line(logEntry(CUTOFF - 1, 'old', { target_hostname: 'old.example' })),
    line(logEntry(NOW, 'recent', { target_hostname: 'recent.example' })),
  ].join('\n') + '\n'
  await writeFile(logPath, original)

  t.mock.method(fs, 'writeFileSync', () => { throw new Error('simulated disk full') })
  assert.throws(
    () => stripExpiredHostnameFieldsFromFile(logPath, NOW),
    /simulated disk full/
  )

  assert.equal(await readFile(logPath, 'utf8'), original)
  await assert.rejects(stat(`${logPath}.retention.tmp`), { code: 'ENOENT' })
})

test('keeps the original log when atomic replacement cannot be renamed', async t => {
  const logPath = await temporaryLog(t)
  const original = [
    line(logEntry(CUTOFF - 1, 'old', { target_hostname: 'old.example' })),
    line(logEntry(NOW, 'recent', { target_hostname: 'recent.example' })),
  ].join('\n') + '\n'
  await writeFile(logPath, original)

  t.mock.method(fs, 'renameSync', () => { throw new Error('simulated rename failure') })
  assert.throws(
    () => stripExpiredHostnameFieldsFromFile(logPath, NOW),
    /simulated rename failure/
  )

  assert.equal(await readFile(logPath, 'utf8'), original)
  await assert.rejects(stat(`${logPath}.retention.tmp`), { code: 'ENOENT' })
})

test('retains the ten-mebibyte startup rotation bound', async t => {
  const logPath = await temporaryLog(t)
  const oversized = `${line(logEntry(NOW, 'oversized', {
    padding: 'x'.repeat(REQUEST_LOG_MAX_BYTES),
  }))}\n`
  await writeFile(logPath, oversized)

  const timer = startRequestLogMaintenance(logPath, { now: () => NOW })
  clearInterval(timer)

  await assert.rejects(stat(logPath), { code: 'ENOENT' })
  assert.equal((await stat(`${logPath}.1`)).size, Buffer.byteLength(oversized))
})

test('retains the ten-mebibyte periodic rotation bound', async t => {
  const logPath = await temporaryLog(t)
  await writeFile(logPath, `${line(logEntry(NOW, 'startup-small'))}\n`)
  const timer = startRequestLogMaintenance(logPath, {
    now: () => NOW,
    intervalMs: 20,
  })
  t.after(() => clearInterval(timer))

  const oversized = `${line(logEntry(NOW, 'periodic-oversized', {
    padding: 'x'.repeat(REQUEST_LOG_MAX_BYTES),
  }))}\n`
  await writeFile(logPath, oversized)

  await waitFor(async () => {
    try {
      const rotated = await stat(`${logPath}.1`)
      await assert.rejects(stat(logPath), { code: 'ENOENT' })
      return rotated.size === Buffer.byteLength(oversized)
    } catch {
      return false
    }
  })
})
