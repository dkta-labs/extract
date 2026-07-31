import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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
  const order = ledger.createOrder()
  const sessionId = `cs_test_${suffix}`
  ledger.attachCheckoutSession(order.id, sessionId)
  ledger.fulfillCheckout({
    eventId: `evt_${suffix}`,
    orderId: order.id,
    sessionId,
    paymentIntentId: `pi_${suffix}`,
    units: order.units,
  })
  const apiKey = apiKeyFor(suffix)
  return { ...ledger.claimCheckout(sessionId, apiKey), apiKey, order, sessionId }
}

test('idempotently binds a paid Checkout Session to client-generated key material', () => {
  const ledger = new CreditLedger(':memory:')
  try {
    const order = ledger.createOrder()
    ledger.attachCheckoutSession(order.id, 'cs_test_fulfillment')

    const fulfilled = ledger.fulfillCheckout({
      eventId: 'evt_fulfillment',
      orderId: order.id,
      sessionId: 'cs_test_fulfillment',
      paymentIntentId: 'pi_fulfillment',
      units: CREDIT_PACKAGE_UNITS,
    })
    assert.deepEqual(fulfilled, {
      duplicate: false,
      alreadyFulfilled: false,
      reversed: false,
    })
    assert.deepEqual(ledger.fulfillCheckout({
      eventId: 'evt_fulfillment',
      orderId: order.id,
      sessionId: 'cs_test_fulfillment',
      paymentIntentId: 'pi_fulfillment',
      units: CREDIT_PACKAGE_UNITS,
    }), { duplicate: true })

    const apiKey = apiKeyFor('fulfillment')
    const claimed = ledger.claimCheckout('cs_test_fulfillment', apiKey)
    assert.equal(claimed.alreadyClaimed, false)
    assert.equal(claimed.balanceUnits, CREDIT_PACKAGE_UNITS)
    assert.equal(ledger.inspectApiKey(apiKey).balanceUnits, CREDIT_PACKAGE_UNITS)
    assert.deepEqual(
      ledger.claimCheckout('cs_test_fulfillment', apiKey),
      { pending: false, alreadyClaimed: true, balanceUnits: CREDIT_PACKAGE_UNITS }
    )
    assert.throws(
      () => ledger.claimCheckout('cs_test_fulfillment', apiKeyFor('different')),
      error => error instanceof CreditError && error.code === 'already_claimed' && error.status === 409
    )
  } finally {
    ledger.close()
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

test('rejects invalid keys, insufficient balances, and mismatched Checkout metadata', () => {
  const ledger = new CreditLedger(':memory:')
  try {
    assert.throws(
      () => ledger.inspectApiKey('ext_live_invalid'),
      error => error instanceof CreditError && error.code === 'invalid_api_key'
    )

    const { apiKey, order, sessionId } = paidKey(ledger, 'boundaries')
    assert.throws(
      () => ledger.fulfillCheckout({
        eventId: 'evt_wrong_amount',
        orderId: order.id,
        sessionId,
        paymentIntentId: 'pi_boundaries',
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
  const pending = ledger.createOrder()
  const pendingSessionId = 'cs_test_pendingclaim'
  ledger.attachCheckoutSession(pending.id, pendingSessionId)
  const blocker = new DatabaseSync(databasePath)
  blocker.exec('BEGIN IMMEDIATE')
  try {
    assert.throws(
      () => ledger.claimCheckout('cs_test_unknownclaim', apiKeyFor('unknown')),
      error => error instanceof CreditError && error.code === 'checkout_not_found'
    )
    assert.deepEqual(
      ledger.claimCheckout(pendingSessionId, apiKeyFor('pending')),
      { pending: true }
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

test('revokes claimed credits on refunds and preserves reversals delivered before completion', () => {
  const ledger = new CreditLedger(':memory:')
  try {
    const paid = paidKey(ledger, 'refund')
    assert.deepEqual(
      ledger.reversePayment({
        eventId: 'evt_refund_reversal',
        paymentIntentId: 'pi_refund',
        reason: 'charge.refunded',
      }),
      { duplicate: false, queued: false, revoked: true, alreadyReversed: false }
    )
    assert.throws(
      () => ledger.inspectApiKey(paid.apiKey),
      error => error instanceof CreditError && error.code === 'invalid_api_key'
    )

    const sessionId = 'cs_test_reversalfirst'
    assert.deepEqual(
      ledger.reversePayment({
        eventId: 'evt_reversal_first',
        paymentIntentId: 'pi_reversal_first',
        reason: 'charge.dispute.created',
      }),
      { duplicate: false, queued: true, revoked: false }
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

test('fails closed on partial prepaid configuration', () => {
  assert.equal(createCreditService({}), null)
  assert.throws(
    () => createCreditService({ CREDIT_DB_PATH: ':memory:' }),
    /prepaid credits require CREDIT_DB_PATH, STRIPE_PAYMENT_LINK_ID, STRIPE_PAYMENT_LINK_URL, and STRIPE_WEBHOOK_SECRET/
  )
})
