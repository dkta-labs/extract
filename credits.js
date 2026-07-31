import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import Stripe from 'stripe'

export const CREDIT_PACKAGE_UNITS = 10_000_000
export const CREDIT_PACKAGE_CENTS = 1_000
export const SINGLE_EXTRACTION_UNITS = 1_000
export const BATCH_EXTRACTION_UNITS = 5_000

const API_KEY_PATTERN = /^ext_live_[A-Za-z0-9_-]{43}$/
const PENDING_ORDER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const FAILED_ORDER_RETENTION_MS = 48 * 60 * 60 * 1000
const SESSION_ID_PATTERN = /^cs_(?:test_|live_)?[A-Za-z0-9_]{8,}$/

export class CreditError extends Error {
  constructor(code, message, status = 400, details = {}) {
    super(message)
    this.name = 'CreditError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function now() {
  return new Date().toISOString()
}

function hashApiKey(apiKey) {
  return createHash('sha256').update(apiKey).digest('hex')
}

function claimState(order, keyHash) {
  if (!order || order.status === 'failed' || order.status === 'reversed') {
    throw new CreditError('checkout_not_found', 'paid Checkout Session not found', 404)
  }
  if (order.status === 'claimed') {
    if (order.key_hash === keyHash) return 'claimed'
    throw new CreditError('already_claimed', 'API key was already claimed with different key material', 409)
  }
  return order.status
}

function transaction(database, operation) {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

export class CreditLedger {
  constructor(databasePath) {
    if (databasePath !== ':memory:') {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 })
    }
    this.database = new DatabaseSync(databasePath, { timeout: 5_000 })
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS credit_orders (
        id TEXT PRIMARY KEY,
        stripe_session_id TEXT UNIQUE,
        stripe_payment_intent_id TEXT UNIQUE,
        units INTEGER NOT NULL CHECK (units > 0),
        status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'claimed', 'failed', 'reversed')),
        api_key_id TEXT,
        reversal_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        balance_units INTEGER NOT NULL CHECK (balance_units >= 0),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        checkout_session_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS stripe_events (
        event_id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS payment_reversals (
        payment_intent_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        received_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS credit_reservations (
        api_key_id TEXT NOT NULL REFERENCES api_keys(id),
        request_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        units INTEGER NOT NULL CHECK (units > 0),
        state TEXT NOT NULL CHECK (state IN ('reserved', 'committed', 'released')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (api_key_id, request_id)
      ) STRICT;
    `)
    this.releaseOrphanedReservations()
    this.cleanupAbandonedOrders()
  }

  close() {
    this.database.close()
  }

  releaseOrphanedReservations() {
    return transaction(this.database, () => {
      const balances = this.database.prepare(`
        SELECT api_key_id, SUM(units) AS units
        FROM credit_reservations
        WHERE state = 'reserved'
        GROUP BY api_key_id
      `).all()
      for (const balance of balances) {
        this.database.prepare(`
          UPDATE api_keys SET balance_units = balance_units + ? WHERE id = ?
        `).run(balance.units, balance.api_key_id)
      }
      const released = this.database.prepare(`
        UPDATE credit_reservations
        SET state = 'released', updated_at = ?
        WHERE state = 'reserved'
      `).run(now())
      return released.changes
    })
  }

  cleanupAbandonedOrders(
    pendingCutoff = new Date(Date.now() - PENDING_ORDER_RETENTION_MS).toISOString(),
    failedCutoff = new Date(Date.now() - FAILED_ORDER_RETENTION_MS).toISOString()
  ) {
    return this.database.prepare(`
      DELETE FROM credit_orders
      WHERE (status = 'pending' AND updated_at < ?)
         OR (status = 'failed' AND updated_at < ?)
    `).run(pendingCutoff, failedCutoff).changes
  }

  createOrder(units = CREDIT_PACKAGE_UNITS) {
    const order = {
      id: `ord_${randomUUID()}`,
      units,
      createdAt: now(),
    }
    this.database.prepare(`
      INSERT INTO credit_orders (id, units, status, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?)
    `).run(order.id, order.units, order.createdAt, order.createdAt)
    return order
  }

  attachCheckoutSession(orderId, sessionId) {
    const result = this.database.prepare(`
      UPDATE credit_orders
      SET stripe_session_id = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND stripe_session_id IS NULL
    `).run(sessionId, now(), orderId)
    if (result.changes !== 1) {
      throw new CreditError('invalid_order_state', 'credit order cannot accept a Checkout Session', 409)
    }
  }

  failOrder(orderId) {
    this.database.prepare(`
      UPDATE credit_orders SET status = 'failed', updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(now(), orderId)
  }

  fulfillCheckout({ eventId, orderId, sessionId, paymentIntentId, units }) {
    return transaction(this.database, () => {
      const seen = this.database.prepare('SELECT 1 FROM stripe_events WHERE event_id = ?').get(eventId)
      if (seen) return { duplicate: true }

      const order = this.database.prepare('SELECT * FROM credit_orders WHERE id = ?').get(orderId)
      if (
        !order ||
        order.stripe_session_id !== sessionId ||
        order.units !== units ||
        (order.stripe_payment_intent_id && order.stripe_payment_intent_id !== paymentIntentId)
      ) {
        throw new CreditError('checkout_mismatch', 'Checkout Session does not match a pending credit order', 400)
      }
      if (order.status === 'failed') {
        throw new CreditError('order_failed', 'credit order is no longer fulfillable', 409)
      }

      this.database.prepare('INSERT INTO stripe_events (event_id, received_at) VALUES (?, ?)')
        .run(eventId, now())
      const reversal = this.database.prepare(`
        SELECT reason FROM payment_reversals WHERE payment_intent_id = ?
      `).get(paymentIntentId)
      if (order.status === 'pending') {
        this.database.prepare(`
          UPDATE credit_orders
          SET status = ?, stripe_payment_intent_id = ?, reversal_reason = ?, updated_at = ?
          WHERE id = ?
        `).run(
          reversal ? 'reversed' : 'paid',
          paymentIntentId,
          reversal?.reason || null,
          now(),
          orderId
        )
      }
      return {
        duplicate: false,
        alreadyFulfilled: order.status !== 'pending',
        reversed: order.status === 'reversed' || Boolean(reversal),
      }
    })
  }

  fulfillPaymentLinkCheckout({ eventId, sessionId, paymentIntentId, units }) {
    return transaction(this.database, () => {
      const seen = this.database.prepare('SELECT 1 FROM stripe_events WHERE event_id = ?').get(eventId)
      if (seen) return { duplicate: true }

      const existing = this.database.prepare(`
        SELECT status, stripe_payment_intent_id, units
        FROM credit_orders
        WHERE stripe_session_id = ?
      `).get(sessionId)
      if (
        existing &&
        (existing.stripe_payment_intent_id !== paymentIntentId || existing.units !== units)
      ) {
        throw new CreditError('checkout_mismatch', 'Checkout Session conflicts with an existing credit order', 400)
      }

      this.database.prepare('INSERT INTO stripe_events (event_id, received_at) VALUES (?, ?)')
        .run(eventId, now())
      if (existing) {
        return {
          duplicate: false,
          alreadyFulfilled: true,
          reversed: existing.status === 'reversed',
        }
      }

      const reversal = this.database.prepare(`
        SELECT reason FROM payment_reversals WHERE payment_intent_id = ?
      `).get(paymentIntentId)
      const timestamp = now()
      this.database.prepare(`
        INSERT INTO credit_orders (
          id, stripe_session_id, stripe_payment_intent_id, units, status,
          reversal_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `ord_${randomUUID()}`,
        sessionId,
        paymentIntentId,
        units,
        reversal ? 'reversed' : 'paid',
        reversal?.reason || null,
        timestamp,
        timestamp
      )
      return {
        duplicate: false,
        alreadyFulfilled: false,
        reversed: Boolean(reversal),
      }
    })
  }

  reversePayment({ eventId, paymentIntentId, reason }) {
    return transaction(this.database, () => {
      const seen = this.database.prepare('SELECT 1 FROM stripe_events WHERE event_id = ?').get(eventId)
      if (seen) return { duplicate: true }

      this.database.prepare('INSERT INTO stripe_events (event_id, received_at) VALUES (?, ?)')
        .run(eventId, now())
      this.database.prepare(`
        INSERT INTO payment_reversals (payment_intent_id, event_id, reason, received_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(payment_intent_id) DO NOTHING
      `).run(paymentIntentId, eventId, reason, now())

      const order = this.database.prepare(`
        SELECT id, api_key_id, status
        FROM credit_orders
        WHERE stripe_payment_intent_id = ?
      `).get(paymentIntentId)
      if (!order) {
        return { duplicate: false, queued: true, revoked: false }
      }
      if (order.status !== 'reversed') {
        this.database.prepare(`
          UPDATE credit_orders
          SET status = 'reversed', reversal_reason = ?, updated_at = ?
          WHERE id = ?
        `).run(reason, now(), order.id)
        if (order.api_key_id) {
          this.database.prepare(`
            UPDATE api_keys SET status = 'revoked' WHERE id = ?
          `).run(order.api_key_id)
        }
      }
      return {
        duplicate: false,
        queued: false,
        revoked: Boolean(order.api_key_id),
        alreadyReversed: order.status === 'reversed',
      }
    })
  }

  claimCheckout(sessionId, apiKey) {
    if (!SESSION_ID_PATTERN.test(sessionId || '')) {
      throw new CreditError('invalid_session', 'a valid Checkout Session ID is required')
    }
    if (!API_KEY_PATTERN.test(apiKey || '')) {
      throw new CreditError('invalid_api_key', 'a valid client-generated API key is required')
    }
    const keyHash = hashApiKey(apiKey)
    const findOrder = () => this.database.prepare(`
      SELECT credit_orders.*, api_keys.key_hash, api_keys.balance_units
      FROM credit_orders
      LEFT JOIN api_keys ON api_keys.id = credit_orders.api_key_id
      WHERE stripe_session_id = ?
    `).get(sessionId)

    const preflight = findOrder()
    const preflightState = claimState(preflight, keyHash)
    if (preflightState === 'pending') return { pending: true }
    if (preflightState === 'claimed') {
      return { pending: false, alreadyClaimed: true, balanceUnits: preflight.balance_units }
    }

    return transaction(this.database, () => {
      const order = findOrder()
      const state = claimState(order, keyHash)
      if (state === 'pending') return { pending: true }
      if (state === 'claimed') {
        return { pending: false, alreadyClaimed: true, balanceUnits: order.balance_units }
      }

      const apiKeyId = randomUUID()
      const timestamp = now()
      this.database.prepare(`
        INSERT INTO api_keys (
          id, key_hash, key_prefix, balance_units, status, checkout_session_id, created_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?)
      `).run(
        apiKeyId,
        keyHash,
        apiKey.slice(0, 17),
        order.units,
        sessionId,
        timestamp
      )
      this.database.prepare(`
        UPDATE credit_orders
        SET status = 'claimed', api_key_id = ?, updated_at = ?
        WHERE id = ? AND status = 'paid'
      `).run(apiKeyId, timestamp, order.id)

      return {
        pending: false,
        alreadyClaimed: false,
        balanceUnits: order.units,
      }
    })
  }

  inspectApiKey(apiKey) {
    if (!API_KEY_PATTERN.test(apiKey || '')) {
      throw new CreditError('invalid_api_key', 'invalid prepaid API key', 401)
    }
    const record = this.database.prepare(`
      SELECT id, key_prefix, balance_units, status FROM api_keys WHERE key_hash = ?
    `).get(hashApiKey(apiKey))
    if (!record || record.status !== 'active') {
      throw new CreditError('invalid_api_key', 'invalid prepaid API key', 401)
    }
    return {
      apiKeyId: record.id,
      keyPrefix: record.key_prefix,
      balanceUnits: record.balance_units,
    }
  }

  reserve(apiKey, requestId, endpoint, units) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId || '')) {
      throw new CreditError('invalid_request_id', 'a valid X-Request-ID UUID is required')
    }
    this.inspectApiKey(apiKey)

    return transaction(this.database, () => {
      const key = this.inspectApiKey(apiKey)
      const existing = this.database.prepare(`
        SELECT state FROM credit_reservations
        WHERE api_key_id = ? AND request_id = ?
      `).get(key.apiKeyId, requestId)
      if (existing?.state === 'committed') {
        throw new CreditError('request_completed', 'this X-Request-ID has already been charged', 409)
      }
      if (existing?.state === 'reserved') {
        throw new CreditError('request_in_progress', 'this X-Request-ID is already in progress', 409)
      }
      if (key.balanceUnits < units) {
        throw new CreditError('insufficient_credits', 'prepaid balance is too low', 402, {
          balanceUnits: key.balanceUnits,
          requiredUnits: units,
        })
      }

      const timestamp = now()
      this.database.prepare(`
        UPDATE api_keys SET balance_units = balance_units - ? WHERE id = ?
      `).run(units, key.apiKeyId)
      if (existing?.state === 'released') {
        this.database.prepare(`
          UPDATE credit_reservations
          SET endpoint = ?, units = ?, state = 'reserved', updated_at = ?
          WHERE api_key_id = ? AND request_id = ?
        `).run(endpoint, units, timestamp, key.apiKeyId, requestId)
      } else {
        this.database.prepare(`
          INSERT INTO credit_reservations (
            api_key_id, request_id, endpoint, units, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'reserved', ?, ?)
        `).run(key.apiKeyId, requestId, endpoint, units, timestamp, timestamp)
      }

      return {
        apiKeyId: key.apiKeyId,
        keyPrefix: key.keyPrefix,
        balanceUnits: key.balanceUnits - units,
      }
    })
  }

  settle(apiKeyId, requestId, succeeded) {
    return transaction(this.database, () => {
      const reservation = this.database.prepare(`
        SELECT units, state FROM credit_reservations WHERE api_key_id = ? AND request_id = ?
      `).get(apiKeyId, requestId)
      if (!reservation) {
        throw new CreditError('reservation_not_found', 'credit reservation not found', 500)
      }
      if (reservation.state !== 'reserved') {
        const key = this.database.prepare('SELECT balance_units FROM api_keys WHERE id = ?').get(apiKeyId)
        return { state: reservation.state, balanceUnits: key.balance_units }
      }

      const nextState = succeeded ? 'committed' : 'released'
      this.database.prepare(`
        UPDATE credit_reservations SET state = ?, updated_at = ?
        WHERE api_key_id = ? AND request_id = ? AND state = 'reserved'
      `).run(nextState, now(), apiKeyId, requestId)
      if (!succeeded) {
        this.database.prepare(`
          UPDATE api_keys SET balance_units = balance_units + ? WHERE id = ?
        `).run(reservation.units, apiKeyId)
      }
      const key = this.database.prepare('SELECT balance_units FROM api_keys WHERE id = ?').get(apiKeyId)
      return { state: nextState, balanceUnits: key.balance_units }
    })
  }
}

export function createCreditService(env = process.env) {
  const required = {
    databasePath: env.CREDIT_DB_PATH,
    paymentLinkId: env.STRIPE_PAYMENT_LINK_ID,
    paymentLinkUrl: env.STRIPE_PAYMENT_LINK_URL,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
  }
  const configured = Object.values(required).filter(Boolean).length
  if (configured === 0) return null
  if (configured !== Object.keys(required).length) {
    throw new Error(
      'prepaid credits require CREDIT_DB_PATH, STRIPE_PAYMENT_LINK_ID, ' +
      'STRIPE_PAYMENT_LINK_URL, and STRIPE_WEBHOOK_SECRET'
    )
  }
  let paymentLinkUrl
  try {
    paymentLinkUrl = new URL(required.paymentLinkUrl)
  } catch {
    throw new Error('invalid Stripe prepaid-credit configuration')
  }
  if (
    !required.paymentLinkId.startsWith('plink_') ||
    !required.webhookSecret.startsWith('whsec_') ||
    paymentLinkUrl.protocol !== 'https:' ||
    paymentLinkUrl.hostname !== 'buy.stripe.com' ||
    paymentLinkUrl.username ||
    paymentLinkUrl.password
  ) {
    throw new Error('invalid Stripe prepaid-credit configuration')
  }

  const ledger = new CreditLedger(required.databasePath)
  return {
    ledger,
    packageUnits: CREDIT_PACKAGE_UNITS,
    packageCents: CREDIT_PACKAGE_CENTS,
    checkout: {
      checkoutUrl: paymentLinkUrl.toString(),
      units: CREDIT_PACKAGE_UNITS,
      amountCents: CREDIT_PACKAGE_CENTS,
    },
    handleWebhook(rawBody, signature) {
      const event = Stripe.webhooks.constructEvent(
        rawBody,
        signature,
        required.webhookSecret,
        300
      )
      if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
        const charge = event.data.object
        const paymentIntentId = typeof charge.payment_intent === 'string'
          ? charge.payment_intent
          : charge.payment_intent?.id
        if (!paymentIntentId) {
          throw new CreditError(
            'reversal_metadata_invalid',
            'payment reversal is missing its PaymentIntent',
            400
          )
        }
        return ledger.reversePayment({
          eventId: event.id,
          paymentIntentId,
          reason: event.type,
        })
      }
      if (event.type !== 'checkout.session.completed') return { ignored: true }

      const session = event.data.object
      const paymentLinkId = typeof session.payment_link === 'string'
        ? session.payment_link
        : session.payment_link?.id
      if (
        paymentLinkId !== required.paymentLinkId ||
        session.payment_status !== 'paid' ||
        session.currency !== 'usd' ||
        session.amount_total !== CREDIT_PACKAGE_CENTS
      ) {
        throw new CreditError(
          'checkout_payment_mismatch',
          'Checkout Session does not match the $10 USD Extract credit Payment Link',
          400
        )
      }
      const paymentIntentId = typeof session.payment_intent === 'string'
        ? session.payment_intent
        : session.payment_intent?.id
      if (!paymentIntentId) {
        throw new CreditError(
          'checkout_metadata_invalid',
          'Checkout Session is missing its PaymentIntent',
          400
        )
      }
      return ledger.fulfillPaymentLinkCheckout({
        eventId: event.id,
        sessionId: session.id,
        paymentIntentId,
        units: CREDIT_PACKAGE_UNITS,
      })
    },
    close() {
      ledger.close()
    },
  }
}
