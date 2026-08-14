import assert from 'node:assert/strict'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import path from 'node:path'

const [hostOnlyPath, listenerHost, listenerPortText, mode = 'first'] = process.argv.slice(2)
assert.ok(hostOnlyPath, 'host-only canary path is required')
assert.ok(listenerHost, 'bridge listener host is required')
const listenerPort = Number(listenerPortText)
assert.ok(Number.isInteger(listenerPort) && listenerPort > 0, 'bridge listener port is required')
assert.ok(mode === 'first' || mode === 'fresh', 'canary mode must be first or fresh')

const hostCanaryBasename = path.basename(hostOnlyPath)
for (const pathName of [
  hostOnlyPath,
  `/source/${hostCanaryBasename}`,
  `/workspace/${hostCanaryBasename}`,
  `/tmp/${hostCanaryBasename}`,
]) {
  assert.equal(existsSync(pathName), false, `host-only canary crossed the capsule boundary at ${pathName}`)
}
assert.equal(Object.hasOwn(process.env, 'AWS_SECRET_ACCESS_KEY'), false, 'AWS credential crossed the capsule boundary')
assert.equal(Object.hasOwn(process.env, 'CAPSULE_HOST_CANARY'), false, 'host canary environment crossed the capsule boundary')
assert.equal(existsSync('/workspace/.git'), false, 'Git metadata was copied into the workspace')

function assertWriteDenied(description, operation) {
  assert.throws(
    operation,
    error => ['EACCES', 'ENOENT', 'EROFS'].includes(error?.code),
    description,
  )
}

assertWriteDenied('source mount accepted a repository write', () => {
  writeFileSync('/source/.dkt208-source-write', 'blocked')
})
assertWriteDenied('source mount accepted a .git write', () => {
  mkdirSync('/source/.git')
})
assertWriteDenied('read-only root filesystem accepted a persistent write', () => {
  writeFileSync('/capsule-root-ro/dkt208-root-persistence', 'blocked')
})
assertWriteDenied('dependency volume accepted a write', () => {
  writeFileSync('/capsule-deps/.dkt208-dependency-write', 'blocked')
})
assertWriteDenied('workspace dependency link accepted a write', () => {
  writeFileSync('/workspace/node_modules/.dkt208-node-modules-write', 'blocked')
})

const writableCanary = '/capsule-tmp/dkt208-writable'
writeFileSync(writableCanary, 'disposable')
unlinkSync(writableCanary)

const ephemeralMarker = '/workspace/.capsule-ephemeral-canary'
if (mode === 'first') {
  assert.equal(existsSync(ephemeralMarker), false, 'workspace marker persisted before first capsule run')
  writeFileSync(ephemeralMarker, 'disposable')
} else {
  assert.equal(existsSync(ephemeralMarker), false, 'workspace marker persisted across capsule runs')
}

await new Promise((resolve, reject) => {
  const socket = connect({ host: listenerHost, port: listenerPort })
  let settled = false
  const finish = callback => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    socket.destroy()
    callback()
  }
  const timer = setTimeout(() => finish(() => reject(new Error('network-none probe timed out'))), 2_000)
  socket.once('error', error => {
    if (error?.code === 'ENETUNREACH' || error?.code === 'EHOSTUNREACH') finish(resolve)
    else finish(() => reject(new Error(`network-none probe returned unexpected ${error?.code || error}`)))
  })
  socket.once('connect', () => finish(() => reject(new Error('network-none probe unexpectedly connected'))))
})

console.log(`capsule boundary canaries passed: host/env absent; source, .git, root, and dependency writes denied; declared write allowed; ${mode} workspace isolation; network denied`)
