import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import Stripe from 'stripe'
import {
  BATCH_EXTRACTION_UNITS,
  CREDIT_PACKAGE_UNITS,
  CreditError,
  CreditLedger,
  SINGLE_EXTRACTION_UNITS,
  createCreditService,
} from '../credits.js'

function apiKeyFor(label) {
  const bytes = Buffer.alloc(32)
  Buffer.from(label).copy(bytes)
  return `ext_live_${bytes.toString('base64url')}`
}

function paidKey(ledger, suffix = 'abcdefgh') {
  const sessionId = `cs_test_${suffix}`
  const paymentIntentId = `pi_${suffix}`
  ledger.fulfillPaymentLinkCheckout({
    eventId: `evt_${suffix}`,
    sessionId,
    paymentIntentId,
    units: CREDIT_PACKAGE_UNITS,
  })
  const apiKey = apiKeyFor(suffix)
  return {
    ...ledger.claimCheckout(sessionId, apiKey),
    apiKey,
    sessionId,
    paymentIntentId,
  }
}

function claimInWorker(databasePath, sessionId, apiKey, gate) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads')
      ;(async () => {
        const { CreditLedger } = await import(workerData.moduleUrl)
        const gate = new Int32Array(workerData.gate)
        Atomics.add(gate, 0, 1)
        Atomics.wait(gate, 1, 0)
        const ledger = new CreditLedger(workerData.databasePath)
        try {
          parentPort.postMessage({
            ok: true,
            value: ledger.claimCheckout(workerData.sessionId, workerData.apiKey),
          })
        } catch (error) {
          parentPort.postMessage({
            ok: false,
            code: error.code,
            status: error.status,
            message: error.message,
          })
        } finally {
          ledger.close()
        }
      })().catch(error => {
        parentPort.postMessage({ ok: false, message: error.message })
      })
    `, {
      eval: true,
      workerData: {
        moduleUrl: new URL('../credits.js', import.meta.url).href,
        databasePath,
        sessionId,
        apiKey,
        gate,
      },
    })
    worker.once('message', resolve)
    worker.once('error', reject)
  })
}

test('idempotently binds a paid Checkout Session to client-generated key material', () => {
  const ledger = new CreditLedger(':memory:')
  try {
    const fulfillment = {
      eventId: 'evt_fulfillment',
      sessionId: 'cs_test_fulfillment',
      paymentIntentId: 'pi_fulfillment',
      units: CREDIT_PACKAGE_UNITS,
    }
    assert.deepEqual(
      ledger.fulfillPaymentLinkCheckout(fulfillment),
      { duplicate: false, alreadyFulfilled: false, reversed: false }
    )
    assert.deepEqual(
      ledger.fulfillPaymentLinkCheckout(fulfillment),
      { duplicate: true }
    )

    const apiKey = apiKeyFor('fulfillment')
    const claimed = ledger.claimCheckout(fulfillment.sessionId, apiKey)
    assert.equal(claimed.alreadyClaimed, false)
    assert.equal(claimed.balanceUnits, CREDIT_PACKAGE_UNITS)
    assert.equal(ledger.inspectApiKey(apiKey).balanceUnits, CREDIT_PACKAGE_UNITS)
    assert.deepEqual(
      ledger.claimCheckout(fulfillment.sessionId, apiKey),
      { alreadyClaimed: true, balanceUnits: CREDIT_PACKAGE_UNITS }
    )
    assert.throws(
      () => ledger.claimCheckout(fulfillment.sessionId, apiKeyFor('different')),
      error => error instanceof CreditError && error.code === 'already_claimed' && error.status === 409
    )
  } finally {
    ledger.close()
  }
})

test('serializes concurrent claims without issuing two credentials', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'extract-credit-concurrency-'))
  const databasePath = path.join(directory, 'credits.sqlite')
  const sessionId = 'cs_test_concurrentclaim'
  const apiKey = apiKeyFor('concurrentclaim')
  let ledger = new CreditLedger(databasePath)
  try {
    ledger.fulfillPaymentLinkCheckout({
      eventId: 'evt_concurrentclaim',
      sessionId,
      paymentIntentId: 'pi_concurrentclaim',
      units: CREDIT_PACKAGE_UNITS,
    })
    ledger.close()

    const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)
    const gateView = new Int32Array(gate)
    const firstClaim = claimInWorker(databasePath, sessionId, apiKey, gate)
    const secondClaim = claimInWorker(databasePath, sessionId, apiKey, gate)
    while (Atomics.load(gateView, 0) < 2) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    Atomics.store(gateView, 1, 1)
    Atomics.notify(gateView, 1, 2)
    const claims = await Promise.all([firstClaim, secondClaim])
    assert.equal(claims.every(claim => claim.ok), true)
    assert.deepEqual(
      claims.map(claim => claim.value.alreadyClaimed).sort(),
      [false, true]
    )

    ledger = new CreditLedger(databasePath)
    assert.equal(ledger.inspectApiKey(apiKey).balanceUnits, CREDIT_PACKAGE_UNITS)
    assert.equal(
      ledger.database.prepare('SELECT COUNT(*) AS count FROM api_keys').get().count,
      1
    )
  } finally {
    try {
      ledger.close()
    } catch {}
    rmSync(directory, { recursive: true, force: true })
  }
})

test('reserves credits atomically, commits success, and releases failed work', () => {
  const ledger = new CreditLedger(':memory:')
  try {
    const { apiKey } = paidKey(ledger, 'reservations')
    const firstRequestId = '45b7c281-c68f-41c5-81ed-720c130720d1'
    const secondRequestId = '2532d27d-c74d-4eca-a627-1180457b80da'

    const first = ledger.reserve(apiKey, firstRequestId, '/v1/extract', SINGLE_EXTRACTION_UNITS)
    assert.equal(first.balanceUnits, CREDIT_PACKAGE_UNITS - SINGLE_EXTRACTION_UNITS)
    assert.deepEqual(
      ledger.settle(first.apiKeyId, firstRequestId, true),
      { state: 'committed', balanceUnits: CREDIT_PACKAGE_UNITS - SINGLE_EXTRACTION_UNITS }
    )
    assert.throws(
      () => ledger.reserve(apiKey, firstRequestId, '/v1/extract', SINGLE_EXTRACTION_UNITS),
      error => error instanceof CreditError && error.code === 'request_completed'
    )

    const second = ledger.reserve(apiKey, secondRequestId, '/v1/extract/batch', BATCH_EXTRACTION_UNITS)
    assert.equal(second.balanceUnits, CREDIT_PACKAGE_UNITS - SINGLE_EXTRACTION_UNITS - BATCH_EXTRACTION_UNITS)
    assert.deepEqual(
      ledger.settle(second.apiKeyId, secondRequestId, false),
      { state: 'released', balanceUnits: CREDIT_PACKAGE_UNITS - SINGLE_EXTRACTION_UNITS }
    )
    assert.equal(ledger.inspectApiKey(apiKey).balanceUnits, CREDIT_PACKAGE_UNITS - SINGLE_EXTRACTION_UNITS)
  } finally {
    ledger.close()
  }
})

test('reclaims a crashed reservation on reopen and permits a safe retry', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'extract-credits-'))
  const databasePath = path.join(directory, 'credits.sqlite')
  const requestId = 'ac1527f7-1edf-456d-a1ef-81166103e90d'
  let apiKey
  let ledger = new CreditLedger(databasePath)
  try {
    apiKey = paidKey(ledger, 'crashrecovery').apiKey
    ledger.reserve(apiKey, requestId, '/v1/extract', SINGLE_EXTRACTION_UNITS)
    ledger.database.prepare(`
      UPDATE credit_reservations SET updated_at = '2000-01-01T00:00:00.000Z'
      WHERE request_id = ?
    `).run(requestId)
    ledger.close()

    ledger = new CreditLedger(databasePath)
    assert.equal(ledger.inspectApiKey(apiKey).balanceUnits, CREDIT_PACKAGE_UNITS)
    const retried = ledger.reserve(apiKey, requestId, '/v1/extract', SINGLE_EXTRACTION_UNITS)
    assert.equal(retried.balanceUnits, CREDIT_PACKAGE_UNITS - SINGLE_EXTRACTION_UNITS)
  } finally {
    try {
      ledger.close()
    } catch {}
    rmSync(directory, { recursive: true, force: true })
  }
})

test('migrates active and legacy-refunded keys into scoped grants', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'extract-credit-migration-'))
  const databasePath = path.join(directory, 'credits.sqlite')
  const requestId = '83ec5e68-99ed-413a-b7ea-091983c0db04'
  let ledger = new CreditLedger(databasePath)
  try {
    const paid = paidKey(ledger, 'migration')
    const reservation = ledger.reserve(
      paid.apiKey,
      requestId,
      '/v1/extract',
      SINGLE_EXTRACTION_UNITS
    )
    ledger.settle(reservation.apiKeyId, requestId, true)
    const refunded = paidKey(ledger, 'legacyrefund')
    const refundedKey = ledger.inspectApiKey(refunded.apiKey)
    ledger.database.prepare(`
      UPDATE credit_orders
      SET status = 'reversed', reversal_reason = 'charge.refunded'
      WHERE stripe_payment_intent_id = ?
    `).run(refunded.paymentIntentId)
    ledger.database.prepare(`
      UPDATE api_keys SET status = 'revoked' WHERE id = ?
    `).run(refundedKey.apiKeyId)
    const mixed = paidKey(ledger, 'legacymixed')
    const mixedKey = ledger.inspectApiKey(mixed.apiKey)
    const mixedRequestId = '3e966ad0-4445-4691-9540-b51aacfc5fb2'
    const mixedReservation = ledger.reserve(
      mixed.apiKey,
      mixedRequestId,
      '/v1/extract',
      SINGLE_EXTRACTION_UNITS
    )
    ledger.settle(mixedReservation.apiKeyId, mixedRequestId, true)
    ledger.fulfillPaymentLinkCheckout({
      eventId: 'evt_legacymixed_second',
      sessionId: 'cs_test_legacymixed_second',
      paymentIntentId: 'pi_legacymixed_second',
      units: CREDIT_PACKAGE_UNITS,
    })
    ledger.database.prepare(`
      UPDATE credit_orders SET status = 'claimed', api_key_id = ?
      WHERE stripe_payment_intent_id = 'pi_legacymixed_second'
    `).run(mixedKey.apiKeyId)
    ledger.database.prepare(`
      UPDATE api_keys SET balance_units = balance_units + ?, status = 'revoked'
      WHERE id = ?
    `).run(CREDIT_PACKAGE_UNITS, mixedKey.apiKeyId)
    ledger.database.prepare(`
      UPDATE credit_orders
      SET status = 'reversed', reversal_reason = 'charge.refunded'
      WHERE stripe_payment_intent_id = ?
    `).run(mixed.paymentIntentId)
    ledger.close()

    const legacyDatabase = new DatabaseSync(databasePath)
    legacyDatabase.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE reservation_grants;
      DROP TABLE topup_fulfillments;
      DROP TABLE topup_intents;
      DROP TABLE api_key_suspensions;
      DROP TABLE credit_grants;
    `)
    legacyDatabase.close()

    ledger = new CreditLedger(databasePath)
    assert.equal(
      ledger.inspectApiKey(paid.apiKey).balanceUnits,
      CREDIT_PACKAGE_UNITS - SINGLE_EXTRACTION_UNITS
    )
    const grant = ledger.database.prepare(`
      SELECT units, remaining_units, status FROM credit_grants
    `).get()
    assert.deepEqual({ ...grant }, {
      units: CREDIT_PACKAGE_UNITS,
      remaining_units: CREDIT_PACKAGE_UNITS - SINGLE_EXTRACTION_UNITS,
      status: 'active',
    })
    const migratedRefundedKey = ledger.database.prepare(`
      SELECT balance_units, status FROM api_keys WHERE id = ?
    `).get(refundedKey.apiKeyId)
    assert.deepEqual(
      { ...migratedRefundedKey },
      { balance_units: 0, status: 'active' }
    )
    const reversedGrant = ledger.database.prepare(`
      SELECT credit_grants.remaining_units, credit_grants.status
      FROM credit_grants
      JOIN credit_orders ON credit_orders.id = credit_grants.credit_order_id
      WHERE credit_orders.stripe_payment_intent_id = ?
    `).get(refunded.paymentIntentId)
    assert.deepEqual(
      { ...reversedGrant },
      { remaining_units: 0, status: 'reversed' }
    )
    assert.equal(ledger.inspectApiKey(refunded.apiKey).balanceUnits, 0)
    const migratedMixedKey = ledger.database.prepare(`
      SELECT balance_units, status FROM api_keys WHERE id = ?
    `).get(mixedKey.apiKeyId)
    assert.deepEqual(
      { ...migratedMixedKey },
      { balance_units: CREDIT_PACKAGE_UNITS, status: 'active' }
    )
    const mixedGrants = ledger.database.prepare(`
      SELECT status, remaining_units
      FROM credit_grants
      WHERE api_key_id = ?
      ORDER BY created_at, rowid
    `).all(mixedKey.apiKeyId)
    assert.deepEqual(mixedGrants.map(row => ({ ...row })), [
      { status: 'reversed', remaining_units: 0 },
      { status: 'active', remaining_units: CREDIT_PACKAGE_UNITS },
    ])
    assert.throws(
      () => ledger.inspectApiKey(mixed.apiKey),
      error => error instanceof CreditError && error.code === 'api_key_suspended'
    )
  } finally {
    try {
      ledger.close()
    } catch {}
    rmSync(directory, { recursive: true, force: true })
  }
})

test('tops up only the authenticated key across every paid use of its reference', () => {
  const ledger = new CreditLedger(':memory:')
  try {
    const first = paidKey(ledger, 'topupfirst')
    const second = paidKey(ledger, 'topupsecond')
    const intent = ledger.createTopUpIntent(first.apiKey)
    assert.match(intent.intentId, /^topup_[A-Za-z0-9_-]{43}$/)
    assert.equal(intent.keyPrefix, first.apiKey.slice(0, 17))

    const fulfillment = {
      eventId: 'evt_topup_first',
      sessionId: 'cs_test_topup_first',
      paymentIntentId: 'pi_topup_first',
      units: CREDIT_PACKAGE_UNITS,
      clientReferenceId: intent.intentId,
    }
    const toppedUp = ledger.fulfillPaymentLinkCheckout(fulfillment)
    assert.equal(toppedUp.toppedUp, true)
    assert.equal(toppedUp.balanceUnits, CREDIT_PACKAGE_UNITS * 2)
    assert.equal(ledger.inspectApiKey(first.apiKey).balanceUnits, CREDIT_PACKAGE_UNITS * 2)
    assert.equal(ledger.inspectApiKey(second.apiKey).balanceUnits, CREDIT_PACKAGE_UNITS)
    assert.deepEqual(
      ledger.claimCheckout(fulfillment.sessionId),
      {
        alreadyClaimed: true,
        toppedUp: true,
        balanceUnits: CREDIT_PACKAGE_UNITS * 2,
        keyPrefix: first.apiKey.slice(0, 17),
        creditUnits: CREDIT_PACKAGE_UNITS,
      }
    )
    assert.deepEqual(
      ledger.fulfillPaymentLinkCheckout(fulfillment),
      { duplicate: true }
    )

    const reused = ledger.fulfillPaymentLinkCheckout({
      eventId: 'evt_topup_reused',
      sessionId: 'cs_test_topup_reused',
      paymentIntentId: 'pi_topup_reused',
      units: CREDIT_PACKAGE_UNITS,
      clientReferenceId: intent.intentId,
    })
    assert.equal(reused.toppedUp, true)
    assert.equal(reused.balanceUnits, CREDIT_PACKAGE_UNITS * 3)
    assert.equal(
      ledger.claimCheckout('cs_test_topup_reused').toppedUp,
      true
    )
    assert.equal(ledger.inspectApiKey(first.apiKey).balanceUnits, CREDIT_PACKAGE_UNITS * 3)
    assert.equal(ledger.inspectApiKey(second.apiKey).balanceUnits, CREDIT_PACKAGE_UNITS)
    assert.equal(
      ledger.database.prepare(`
        SELECT COUNT(*) AS count FROM topup_fulfillments WHERE topup_intent_id = ?
      `).get(intent.intentId).count,
      2
    )
  } finally {
    ledger.close()
  }
})

test('fulfills a late Payment Link payment against the originally authenticated key', () => {
  const ledger = new CreditLedger(':memory:')
  try {
    const paid = paidKey(ledger, 'latetopup')
    const intent = ledger.createTopUpIntent(paid.apiKey)
    ledger.database.prepare(`
      UPDATE topup_intents SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?
    `).run(intent.intentId)
    const fulfillment = ledger.fulfillPaymentLinkCheckout({
      eventId: 'evt_late_topup',
      sessionId: 'cs_test_late_topup',
      paymentIntentId: 'pi_late_topup',
      units: CREDIT_PACKAGE_UNITS,
      clientReferenceId: intent.intentId,
    })
    assert.equal(fulfillment.toppedUp, true)
    assert.equal(fulfillment.balanceUnits, CREDIT_PACKAGE_UNITS * 2)
    assert.equal(ledger.inspectApiKey(paid.apiKey).balanceUnits, CREDIT_PACKAGE_UNITS * 2)
    assert.equal(ledger.claimCheckout('cs_test_late_topup').toppedUp, true)
  } finally {
    ledger.close()
  }
})

test('allocates a debit across grants and restores the exact grants on failure', () => {
  const ledger = new CreditLedger(':memory:')
  try {
    const paid = paidKey(ledger, 'allocation')
    const intent = ledger.createTopUpIntent(paid.apiKey)
    ledger.fulfillPaymentLinkCheckout({
      eventId: 'evt_allocation_topup',
      sessionId: 'cs_test_allocation_topup',
      paymentIntentId: 'pi_allocation_topup',
      units: CREDIT_PACKAGE_UNITS,
      clientReferenceId: intent.intentId,
    })
    const firstGrant = ledger.database.prepare(`
      SELECT id FROM credit_grants ORDER BY created_at, rowid LIMIT 1
    `).get()
    ledger.database.prepare(`
      UPDATE credit_grants SET remaining_units = 500 WHERE id = ?
    `).run(firstGrant.id)
    const key = ledger.inspectApiKey(paid.apiKey)
    ledger.database.prepare(`
      UPDATE api_keys SET balance_units = ? WHERE id = ?
    `).run(CREDIT_PACKAGE_UNITS + 500, key.apiKeyId)

    const requestId = '23820535-d837-4478-9396-70815775fc38'
    const reservation = ledger.reserve(
      paid.apiKey,
      requestId,
      '/v1/extract',
      SINGLE_EXTRACTION_UNITS
    )
    const allocations = ledger.database.prepare(`
      SELECT units FROM reservation_grants
      WHERE api_key_id = ? AND request_id = ?
      ORDER BY units
    `).all(reservation.apiKeyId, requestId)
    assert.deepEqual(allocations.map(allocation => ({ ...allocation })), [{ units: 500 }, { units: 500 }])
    assert.deepEqual(
      ledger.settle(reservation.apiKeyId, requestId, false),
      { state: 'released', balanceUnits: CREDIT_PACKAGE_UNITS + 500 }
    )
    assert.equal(
      ledger.database.prepare(`
        SELECT COUNT(*) AS count FROM reservation_grants
        WHERE api_key_id = ? AND request_id = ?
      `).get(reservation.apiKeyId, requestId).count,
      0
    )
  } finally {
    ledger.close()
  }
})

test('rejects invalid keys, insufficient balances, and mismatched Checkout metadata', () => {
  const ledger = new CreditLedger(':memory:')
  try {
    assert.throws(
      () => ledger.inspectApiKey('ext_live_invalid'),
      error => error instanceof CreditError && error.code === 'invalid_api_key'
    )

    const { apiKey, sessionId, paymentIntentId } = paidKey(ledger, 'boundaries')
    assert.throws(
      () => ledger.fulfillPaymentLinkCheckout({
        eventId: 'evt_wrong_amount',
        sessionId,
        paymentIntentId,
        units: CREDIT_PACKAGE_UNITS - 1,
      }),
      error => error instanceof CreditError && error.code === 'checkout_mismatch'
    )

    const key = ledger.inspectApiKey(apiKey)
    ledger.database.prepare('UPDATE api_keys SET balance_units = 999 WHERE id = ?').run(key.apiKeyId)
    assert.throws(
      () => ledger.reserve(
        apiKey,
        '960b60a1-3c68-477b-a735-29f00ee70375',
        '/v1/extract',
        SINGLE_EXTRACTION_UNITS
      ),
      error => error instanceof CreditError &&
        error.code === 'insufficient_credits' &&
        error.details.balanceUnits === 999
    )
  } finally {
    ledger.close()
  }
})

test('rejects unknown credentials without taking the SQLite write lock', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'extract-credit-claim-'))
  const databasePath = path.join(directory, 'credits.sqlite')
  const ledger = new CreditLedger(databasePath)
  const blocker = new DatabaseSync(databasePath)
  blocker.exec('BEGIN IMMEDIATE')
  try {
    assert.throws(
      () => ledger.claimCheckout('cs_test_unknownclaim', apiKeyFor('unknown')),
      error => error instanceof CreditError && error.code === 'checkout_not_found'
    )
    assert.throws(
      () => ledger.reserve(
        `ext_live_${'A'.repeat(43)}`,
        '587aaac4-045f-4e0b-9a9f-b04c46b1a468',
        '/v1/extract',
        SINGLE_EXTRACTION_UNITS
      ),
      error => error instanceof CreditError && error.code === 'invalid_api_key'
    )
  } finally {
    blocker.exec('ROLLBACK')
    blocker.close()
    ledger.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('verifies Stripe signatures and exact paid amount before fulfillment', () => {
  const webhookSecret = 'whsec_credit_contract'
  const service = createCreditService({
    CREDIT_DB_PATH: ':memory:',
    STRIPE_PAYMENT_LINK_ID: 'plink_credit_contract',
    STRIPE_PAYMENT_LINK_URL: 'https://buy.stripe.com/test_credit_contract',
    STRIPE_WEBHOOK_SECRET: webhookSecret,
  })
  try {
    const sessionId = 'cs_test_paymentcontract'
    const payload = amountTotal => JSON.stringify({
      id: `evt_payment_${amountTotal}`,
      object: 'event',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId,
          object: 'checkout.session',
          payment_status: 'paid',
          currency: 'usd',
          amount_total: amountTotal,
          payment_intent: 'pi_paymentcontract',
          payment_link: 'plink_credit_contract',
        },
      },
    })

    const wrongAmount = payload(100)
    const wrongAmountSignature = Stripe.webhooks.generateTestHeaderString({
      payload: wrongAmount,
      secret: webhookSecret,
    })
    assert.throws(
      () => service.handleWebhook(Buffer.from(wrongAmount), wrongAmountSignature),
      error => error instanceof CreditError && error.code === 'checkout_payment_mismatch'
    )

    const paid = payload(1_000)
    const paidSignature = Stripe.webhooks.generateTestHeaderString({
      payload: paid,
      secret: webhookSecret,
    })
    assert.deepEqual(
      service.handleWebhook(Buffer.from(paid), paidSignature),
      { duplicate: false, alreadyFulfilled: false, reversed: false }
    )
    const apiKey = apiKeyFor('paymentcontract')
    const claimed = service.ledger.claimCheckout(sessionId, apiKey)
    assert.equal(claimed.alreadyClaimed, false)
    assert.throws(
      () => service.handleWebhook(Buffer.from(paid), 't=1,v1=invalid'),
      /No signatures found matching the expected signature/
    )
  } finally {
    service.close()
  }
})

test('removes only an unspent refunded grant and leaves its key usable', () => {
  const ledger = new CreditLedger(':memory:')
  try {
    const paid = paidKey(ledger, 'refund')
    assert.deepEqual(
      ledger.reversePayment({
        eventId: 'evt_refund_reversal',
        paymentIntentId: 'pi_refund',
        reason: 'charge.refunded',
      }),
      { duplicate: false, queued: false, suspended: false, alreadyReversed: false }
    )
    assert.equal(ledger.inspectApiKey(paid.apiKey).balanceUnits, 0)
    const grant = ledger.database.prepare(`
      SELECT remaining_units, status FROM credit_grants
    `).get()
    assert.deepEqual({ ...grant }, { remaining_units: 0, status: 'reversed' })
  } finally {
    ledger.close()
  }
})

test('suspends a partially spent refunded key without removing unrelated grants', () => {
  const ledger = new CreditLedger(':memory:')
  try {
    const paid = paidKey(ledger, 'partialrefund')
    const topup = ledger.createTopUpIntent(paid.apiKey)
    ledger.fulfillPaymentLinkCheckout({
      eventId: 'evt_partial_topup',
      sessionId: 'cs_test_partial_topup',
      paymentIntentId: 'pi_partial_topup',
      units: CREDIT_PACKAGE_UNITS,
      clientReferenceId: topup.intentId,
    })
    const committedRequestId = '26904354-22b5-4efb-a772-23b4f606893a'
    const committed = ledger.reserve(
      paid.apiKey,
      committedRequestId,
      '/v1/extract',
      SINGLE_EXTRACTION_UNITS
    )
    ledger.settle(committed.apiKeyId, committedRequestId, true)
    const pendingRequestId = 'b287cae4-6586-45a6-a768-f319e5ce3f61'
    ledger.reserve(paid.apiKey, pendingRequestId, '/v1/extract', SINGLE_EXTRACTION_UNITS)

    assert.deepEqual(
      ledger.reversePayment({
        eventId: 'evt_partial_refund',
        paymentIntentId: paid.paymentIntentId,
        reason: 'charge.refunded',
      }),
      { duplicate: false, queued: false, suspended: true, alreadyReversed: false }
    )
    assert.deepEqual(
      ledger.settle(committed.apiKeyId, pendingRequestId, false),
      { state: 'released', balanceUnits: CREDIT_PACKAGE_UNITS }
    )
    assert.throws(
      () => ledger.inspectApiKey(paid.apiKey),
      error => error instanceof CreditError &&
        error.code === 'api_key_suspended' &&
        error.status === 403
    )
    const grants = ledger.database.prepare(`
      SELECT status, remaining_units FROM credit_grants ORDER BY created_at, rowid
    `).all()
    assert.deepEqual(grants.map(grant => ({ ...grant })), [
      { status: 'reversed', remaining_units: 0 },
      { status: 'active', remaining_units: CREDIT_PACKAGE_UNITS },
    ])
  } finally {
    ledger.close()
  }
})

test('suspends disputes and preserves reversals delivered before completion', () => {
  const ledger = new CreditLedger(':memory:')
  try {
    const disputed = paidKey(ledger, 'dispute')
    assert.deepEqual(
      ledger.reversePayment({
        eventId: 'evt_dispute_reversal',
        paymentIntentId: disputed.paymentIntentId,
        reason: 'charge.dispute.created',
      }),
      { duplicate: false, queued: false, suspended: true, alreadyReversed: false }
    )
    assert.throws(
      () => ledger.inspectApiKey(disputed.apiKey),
      error => error instanceof CreditError && error.code === 'api_key_suspended'
    )

    const sessionId = 'cs_test_reversalfirst'
    assert.deepEqual(
      ledger.reversePayment({
        eventId: 'evt_reversal_first',
        paymentIntentId: 'pi_reversal_first',
        reason: 'charge.dispute.created',
      }),
      { duplicate: false, queued: true, suspended: false }
    )
    assert.deepEqual(
      ledger.fulfillPaymentLinkCheckout({
        eventId: 'evt_completion_second',
        sessionId,
        paymentIntentId: 'pi_reversal_first',
        units: CREDIT_PACKAGE_UNITS,
      }),
      { duplicate: false, alreadyFulfilled: false, reversed: true }
    )
    assert.throws(
      () => ledger.claimCheckout(sessionId, apiKeyFor('reversal')),
      error => error instanceof CreditError && error.code === 'checkout_not_found'
    )
  } finally {
    ledger.close()
  }
})

test('stays disabled with only a database path and fails closed on partial Stripe configuration', () => {
  assert.equal(createCreditService({}), null)
  assert.equal(createCreditService({ CREDIT_DB_PATH: ':memory:' }), null)
  assert.throws(
    () => createCreditService({
      CREDIT_DB_PATH: ':memory:',
      STRIPE_PAYMENT_LINK_ID: 'plink_partial',
    }),
    /prepaid credits require CREDIT_DB_PATH, STRIPE_PAYMENT_LINK_ID, STRIPE_PAYMENT_LINK_URL, and STRIPE_WEBHOOK_SECRET/
  )
})
