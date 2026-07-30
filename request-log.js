import fs from 'node:fs'
import path from 'node:path'

export const REQUEST_LOG_MAX_BYTES = 10 * 1024 * 1024
export const REQUEST_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const REQUEST_LOG_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000

const TARGET_HOSTNAME_FIELDS = [
  'target_hostname',
  'target_hostname_1',
  'target_hostname_2',
  'target_hostname_3',
  'target_hostname_4',
  'target_hostname_5',
]

function stripExpiredHostnameFieldsFromContents(contents, cutoff) {
  const endsWithNewline = contents.endsWith('\n')
  const lines = contents.split('\n')
  if (endsWithNewline) lines.pop()

  let stripped = 0
  for (const [index, line] of lines.entries()) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      throw new Error(`malformed JSONL at line ${index + 1}`)
    }

    const timestamp = typeof entry?.ts === 'string' ? Date.parse(entry.ts) : Number.NaN
    if (!Number.isFinite(timestamp)) {
      throw new Error(`invalid timestamp at line ${index + 1}`)
    }

    if (timestamp >= cutoff) continue

    let changed = false
    for (const field of TARGET_HOSTNAME_FIELDS) {
      if (Object.hasOwn(entry, field)) {
        delete entry[field]
        changed = true
      }
    }
    if (changed) {
      lines[index] = JSON.stringify(entry)
      stripped += 1
    }
  }

  return {
    contents: `${lines.join('\n')}${endsWithNewline ? '\n' : ''}`,
    stripped,
  }
}

function replaceFileAtomically(filePath, contents, mode) {
  const temporaryPath = `${filePath}.retention.tmp`
  let descriptor

  try {
    try {
      fs.unlinkSync(temporaryPath)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }

    descriptor = fs.openSync(temporaryPath, 'wx', mode)
    fs.writeFileSync(descriptor, contents, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporaryPath, filePath)
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor) } catch { /* preserve the original error */ }
    }
    try { fs.unlinkSync(temporaryPath) } catch { /* best-effort cleanup */ }
    throw error
  }
}

export function stripExpiredHostnameFieldsFromFile(filePath, now = Date.now()) {
  let stat
  let contents
  try {
    stat = fs.statSync(filePath)
    contents = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { stripped: 0, missing: true }
    throw error
  }

  if (contents === '') return { stripped: 0, missing: false }

  const result = stripExpiredHostnameFieldsFromContents(
    contents,
    now - REQUEST_LOG_RETENTION_MS
  )
  if (result.stripped > 0) {
    replaceFileAtomically(filePath, result.contents, stat.mode & 0o777)
  }
  return { stripped: result.stripped, missing: false }
}

export function stripExpiredHostnameFields(logPath, now = Date.now()) {
  let succeeded = true
  for (const filePath of [logPath, `${logPath}.1`]) {
    try {
      stripExpiredHostnameFieldsFromFile(filePath, now)
    } catch (error) {
      succeeded = false
      console.warn(`request log hostname retention failed for ${path.basename(filePath)}: ${error.message}`)
    }
  }
  return succeeded
}

export function rotateRequestLog(logPath) {
  try {
    const stat = fs.statSync(logPath)
    if (stat.size > REQUEST_LOG_MAX_BYTES) {
      fs.renameSync(logPath, `${logPath}.1`)
      console.log('Log rotated: requests.jsonl -> requests.jsonl.1')
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`request log rotation failed: ${error.message}`)
    }
  }
}

export function startRequestLogMaintenance(logPath, options = {}) {
  const now = options.now || Date.now
  const intervalMs = options.intervalMs || REQUEST_LOG_MAINTENANCE_INTERVAL_MS
  const startupSucceeded = stripExpiredHostnameFields(logPath, now())
  if (startupSucceeded) rotateRequestLog(logPath)

  const timer = setInterval(() => stripExpiredHostnameFields(logPath, now()), intervalMs)
  timer.unref()
  return timer
}
