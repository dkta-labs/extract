import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import Stripe from 'stripe'

export const CREDIT_PACKAGE_UNITS = 10_000_000
export const CREDIT_PACKAGE_CENTS = 1_000
export const SINGLE_EXTRACTION_UNITS = 1_000
export const BATCH_EXTRACTION_UNITS = 5_000

const API_KEY_PATTERN = /^ext_live_[A-Za-z0-9_-]{43}$/
const SESSION_ID_PATTERN = /^cs_(?:test_|live_)?[A-Za-z0-9_]{8,}$/
const TOPUP_INTENT_PATTERN = /^topup_[A-Za-z0-9_-]{43}$/

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
        stripe_session_id TEXT NOT NULL UNIQUE,
        stripe_payment_intent_id TEXT NOT NULL UNIQUE,
        units INTEGER NOT NULL CHECK (units > 0),
        status TEXT NOT NULL CHECK (status IN ('paid', 'claimed', 'reversed')),
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

      CREATE TABLE IF NOT EXISTS credit_grants (
        id TEXT PRIMARY KEY,
        credit_order_id TEXT NOT NULL UNIQUE REFERENCES credit_orders(id),
        api_key_id TEXT NOT NULL REFERENCES api_keys(id),
        units INTEGER NOT NULL CHECK (units > 0),
        remaining_units INTEGER NOT NULL CHECK (
          remaining_units >= 0 AND remaining_units <= units
        ),
        status TEXT NOT NULL CHECK (status IN ('active', 'reversed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS reservation_grants (
        api_key_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        credit_grant_id TEXT NOT NULL REFERENCES credit_grants(id),
        units INTEGER NOT NULL CHECK (units > 0),
        PRIMARY KEY (api_key_id, request_id, credit_grant_id),
        FOREIGN KEY (api_key_id, request_id)
          REFERENCES credit_reservations(api_key_id, request_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS topup_intents (
        id TEXT PRIMARY KEY,
        api_key_id TEXT NOT NULL REFERENCES api_keys(id),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS topup_fulfillments (
        credit_order_id TEXT PRIMARY KEY REFERENCES credit_orders(id),
        topup_intent_id TEXT NOT NULL REFERENCES topup_intents(id),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS api_key_suspensions (
        api_key_id TEXT PRIMARY KEY REFERENCES api_keys(id),
        credit_order_id TEXT REFERENCES credit_orders(id),
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `)
    this.migrateCreditGrants()
    this.releaseOrphanedReservations()
  }

  close() {
    this.database.close()
  }

  migrateCreditGrants() {
    return transaction(this.database, () => {
      const keys = this.database.prepare(`
        SELECT id, balance_units, status FROM api_keys ORDER BY created_at, id
      `).all()
      let migrated = 0
      for (const key of keys) {
        const existing = this.database.prepare(`
          SELECT COUNT(*) AS count FROM credit_grants WHERE api_key_id = ?
        `).get(key.id)
        if (existing.count > 0) continue

        const orders = this.database.prepare(`
          SELECT id, units, status, reversal_reason, created_at, updated_at
          FROM credit_orders
          WHERE api_key_id = ? AND status IN ('claimed', 'reversed')
          ORDER BY created_at, rowid
        `).all(key.id)
        const fundedUnits = orders.reduce((sum, order) => sum + order.units, 0)
        if (key.balance_units > fundedUnits) {
          throw new Error('credit ledger migration found an unfunded API key balance')
        }

        let consumedUnits = fundedUnits - key.balance_units
        let migratedBalance = 0
        let reversedSpentOrder = null
        for (const order of orders) {
          const reversed = order.status === 'reversed'
          const consumedFromGrant = Math.min(consumedUnits, order.units)
          consumedUnits -= consumedFromGrant
          const remainingUnits = reversed ? 0 : order.units - consumedFromGrant
          if (reversed && consumedFromGrant > 0 && !reversedSpentOrder) {
            reversedSpentOrder = order
          }
          migratedBalance += remainingUnits
          this.database.prepare(`
            INSERT INTO credit_grants (
              id, credit_order_id, api_key_id, units, remaining_units,
              status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            `grt_${randomUUID()}`,
            order.id,
            key.id,
            order.units,
            remainingUnits,
            reversed ? 'reversed' : 'active',
            order.created_at,
            order.updated_at
          )
          migrated += 1
        }

        const hasReversedOrder = orders.some(order => order.status === 'reversed')
        const migratedStatus = key.status === 'revoked' && hasReversedOrder
          ? 'active'
          : key.status
        this.database.prepare(`
          UPDATE api_keys SET balance_units = ?, status = ? WHERE id = ?
        `).run(migratedBalance, migratedStatus, key.id)
        if (reversedSpentOrder) {
          this.database.prepare(`
            INSERT OR IGNORE INTO api_key_suspensions (
              api_key_id, credit_order_id, reason, created_at
            ) VALUES (?, ?, ?, ?)
          `).run(
            key.id,
            reversedSpentOrder.id,
            reversedSpentOrder.reversal_reason || 'legacy_reversal_after_spend',
            now()
          )
        }
      }
      return migrated
    })
  }

  restoreGrantUnits(apiKeyId, units) {
    let unitsToRestore = units
    const grants = this.database.prepare(`
      SELECT id, units, remaining_units
      FROM credit_grants
      WHERE api_key_id = ? AND status = 'active' AND remaining_units < units
      ORDER BY created_at DESC, rowid DESC
    `).all(apiKeyId)
    for (const grant of grants) {
      if (unitsToRestore === 0) break
      const restored = Math.min(unitsToRestore, grant.units - grant.remaining_units)
      this.database.prepare(`
        UPDATE credit_grants
        SET remaining_units = remaining_units + ?, updated_at = ?
        WHERE id = ? AND status = 'active'
      `).run(restored, now(), grant.id)
      unitsToRestore -= restored
    }
    return units - unitsToRestore
  }

  releaseOrphanedReservations() {
    return transaction(this.database, () => {
      const reservations = this.database.prepare(`
        SELECT api_key_id, request_id, units
        FROM credit_reservations
        WHERE state = 'reserved'
      `).all()
      const timestamp = now()
      for (const reservation of reservations) {
        const allocations = this.database.prepare(`
          SELECT credit_grant_id, units
          FROM reservation_grants
          WHERE api_key_id = ? AND request_id = ?
        `).all(reservation.api_key_id, reservation.request_id)
        let restoredUnits = 0
        if (allocations.length > 0) {
          for (const allocation of allocations) {
            const restored = this.database.prepare(`
              UPDATE credit_grants
              SET remaining_units = remaining_units + ?, updated_at = ?
              WHERE id = ? AND status = 'active'
            `).run(allocation.units, timestamp, allocation.credit_grant_id)
            if (restored.changes === 1) restoredUnits += allocation.units
          }
        } else {
          restoredUnits = this.restoreGrantUnits(reservation.api_key_id, reservation.units)
        }
        if (restoredUnits > 0) {
          this.database.prepare(`
            UPDATE api_keys SET balance_units = balance_units + ? WHERE id = ?
          `).run(restoredUnits, reservation.api_key_id)
        }
        this.database.prepare(`
          DELETE FROM reservation_grants WHERE api_key_id = ? AND request_id = ?
        `).run(reservation.api_key_id, reservation.request_id)
        this.database.prepare(`
          UPDATE credit_reservations
          SET state = 'released', updated_at = ?
          WHERE api_key_id = ? AND request_id = ? AND state = 'reserved'
        `).run(timestamp, reservation.api_key_id, reservation.request_id)
      }
      return reservations.length
    })
  }

  fulfillPaymentLinkCheckout({
    eventId,
    sessionId,
    paymentIntentId,
    units,
    clientReferenceId = null,
  }) {
    return transaction(this.database, () => {
      const seen = this.database.prepare('SELECT 1 FROM stripe_events WHERE event_id = ?').get(eventId)
      if (seen) return { duplicate: true }

      const existing = this.database.prepare(`
        SELECT
          credit_orders.status,
          credit_orders.stripe_payment_intent_id,
          credit_orders.units,
          topup_intents.id AS client_reference_id
        FROM credit_orders
        LEFT JOIN topup_fulfillments
          ON topup_fulfillments.credit_order_id = credit_orders.id
        LEFT JOIN topup_intents ON topup_intents.id = topup_fulfillments.topup_intent_id
        WHERE credit_orders.stripe_session_id = ?
      `).get(sessionId)
      if (
        existing &&
        (
          existing.stripe_payment_intent_id !== paymentIntentId ||
          existing.units !== units ||
          (existing.client_reference_id && existing.client_reference_id !== clientReferenceId)
        )
      ) {
        throw new CreditError('checkout_mismatch', 'Checkout Session conflicts with an existing credit order', 400)
      }

      this.database.prepare('INSERT INTO stripe_events (event_id, received_at) VALUES (?, ?)')
        .run(eventId, now())
      if (existing) {
        const result = {
          duplicate: false,
          alreadyFulfilled: true,
          reversed: existing.status === 'reversed',
        }
        if (existing.client_reference_id) result.toppedUp = true
        return result
      }

      const timestamp = now()
      const topupIntent = TOPUP_INTENT_PATTERN.test(clientReferenceId || '')
        ? this.database.prepare(`
            SELECT id, api_key_id
            FROM topup_intents
            WHERE id = ?
          `).get(clientReferenceId)
        : null
      const reversal = this.database.prepare(`
        SELECT reason FROM payment_reversals WHERE payment_intent_id = ?
      `).get(paymentIntentId)
      const orderId = `ord_${randomUUID()}`
      const orderStatus = reversal ? 'reversed' : topupIntent ? 'claimed' : 'paid'
      this.database.prepare(`
        INSERT INTO credit_orders (
          id, stripe_session_id, stripe_payment_intent_id, units, status,
          api_key_id, reversal_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderId,
        sessionId,
        paymentIntentId,
        units,
        orderStatus,
        topupIntent?.api_key_id || null,
        reversal?.reason || null,
        timestamp,
        timestamp
      )

      if (topupIntent) {
        this.database.prepare(`
          INSERT INTO credit_grants (
            id, credit_order_id, api_key_id, units, remaining_units,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          `grt_${randomUUID()}`,
          orderId,
          topupIntent.api_key_id,
          units,
          reversal ? 0 : units,
          reversal ? 'reversed' : 'active',
          timestamp,
          timestamp
        )
        this.database.prepare(`
          INSERT INTO topup_fulfillments (
            credit_order_id, topup_intent_id, created_at
          ) VALUES (?, ?, ?)
        `).run(orderId, topupIntent.id, timestamp)
        if (!reversal) {
          this.database.prepare(`
            UPDATE api_keys SET balance_units = balance_units + ? WHERE id = ?
          `).run(units, topupIntent.api_key_id)
        } else if (reversal.reason === 'charge.dispute.created') {
          this.database.prepare(`
            INSERT OR IGNORE INTO api_key_suspensions (
              api_key_id, credit_order_id, reason, created_at
            ) VALUES (?, ?, ?, ?)
          `).run(topupIntent.api_key_id, orderId, reversal.reason, timestamp)
        }
        const key = this.database.prepare(`
          SELECT key_prefix, balance_units FROM api_keys WHERE id = ?
        `).get(topupIntent.api_key_id)
        return {
          duplicate: false,
          alreadyFulfilled: false,
          reversed: Boolean(reversal),
          toppedUp: true,
          keyPrefix: key.key_prefix,
          balanceUnits: key.balance_units,
        }
      }

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

      const timestamp = now()
      this.database.prepare('INSERT INTO stripe_events (event_id, received_at) VALUES (?, ?)')
        .run(eventId, timestamp)
      this.database.prepare(`
        INSERT INTO payment_reversals (payment_intent_id, event_id, reason, received_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(payment_intent_id) DO UPDATE SET
          event_id = CASE
            WHEN excluded.reason = 'charge.dispute.created' THEN excluded.event_id
            ELSE payment_reversals.event_id
          END,
          reason = CASE
            WHEN excluded.reason = 'charge.dispute.created' THEN excluded.reason
            ELSE payment_reversals.reason
          END,
          received_at = CASE
            WHEN excluded.reason = 'charge.dispute.created' THEN excluded.received_at
            ELSE payment_reversals.received_at
          END
      `).run(paymentIntentId, eventId, reason, timestamp)

      const order = this.database.prepare(`
        SELECT id, api_key_id, status
        FROM credit_orders
        WHERE stripe_payment_intent_id = ?
      `).get(paymentIntentId)
      if (!order) {
        return { duplicate: false, queued: true, suspended: false }
      }

      const alreadyReversed = order.status === 'reversed'
      if (!alreadyReversed) {
        this.database.prepare(`
          UPDATE credit_orders
          SET status = 'reversed', reversal_reason = ?, updated_at = ?
          WHERE id = ?
        `).run(reason, timestamp, order.id)
      }

      let spentUnits = 0
      const grant = this.database.prepare(`
        SELECT id, units, remaining_units, status
        FROM credit_grants
        WHERE credit_order_id = ?
      `).get(order.id)
      if (grant && grant.status === 'active') {
        spentUnits = grant.units - grant.remaining_units
        const debit = this.database.prepare(`
          UPDATE api_keys
          SET balance_units = balance_units - ?
          WHERE id = ? AND balance_units >= ?
        `).run(grant.remaining_units, order.api_key_id, grant.remaining_units)
        if (debit.changes !== 1) {
          throw new Error('credit grant reversal exceeds the API key balance')
        }
        this.database.prepare(`
          UPDATE credit_grants
          SET remaining_units = 0, status = 'reversed', updated_at = ?
          WHERE id = ?
        `).run(timestamp, grant.id)
      }

      if (
        order.api_key_id &&
        (reason === 'charge.dispute.created' || spentUnits > 0)
      ) {
        this.database.prepare(`
          INSERT INTO api_key_suspensions (
            api_key_id, credit_order_id, reason, created_at
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(api_key_id) DO UPDATE SET
            credit_order_id = excluded.credit_order_id,
            reason = CASE
              WHEN excluded.reason = 'charge.dispute.created' THEN excluded.reason
              ELSE api_key_suspensions.reason
            END
        `).run(order.api_key_id, order.id, reason, timestamp)
      }
      const suspension = order.api_key_id
        ? this.database.prepare(`
            SELECT 1 FROM api_key_suspensions WHERE api_key_id = ?
          `).get(order.api_key_id)
        : null
      return {
        duplicate: false,
        queued: false,
        suspended: Boolean(suspension),
        alreadyReversed,
      }
    })
  }

  claimCheckout(sessionId, apiKey) {
    if (!SESSION_ID_PATTERN.test(sessionId || '')) {
      throw new CreditError('invalid_session', 'a valid Checkout Session ID is required')
    }
    const findOrder = () => this.database.prepare(`
      SELECT
        credit_orders.*,
        api_keys.key_hash,
        api_keys.key_prefix,
        api_keys.balance_units,
        topup_intents.id AS topup_intent_id
      FROM credit_orders
      LEFT JOIN api_keys ON api_keys.id = credit_orders.api_key_id
      LEFT JOIN topup_fulfillments
        ON topup_fulfillments.credit_order_id = credit_orders.id
      LEFT JOIN topup_intents ON topup_intents.id = topup_fulfillments.topup_intent_id
      WHERE credit_orders.stripe_session_id = ?
    `).get(sessionId)

    const preflight = findOrder()
    if (!preflight || preflight.status === 'reversed') {
      throw new CreditError('checkout_not_found', 'paid Checkout Session not found', 404)
    }
    if (preflight.topup_intent_id && preflight.status === 'claimed') {
      return {
        alreadyClaimed: true,
        toppedUp: true,
        balanceUnits: preflight.balance_units,
        keyPrefix: preflight.key_prefix,
        creditUnits: preflight.units,
      }
    }
    if (!API_KEY_PATTERN.test(apiKey || '')) {
      throw new CreditError('invalid_api_key', 'a valid client-generated API key is required')
    }
    const keyHash = hashApiKey(apiKey)
    const preflightState = claimState(preflight, keyHash)
    if (preflightState === 'claimed') {
      return { alreadyClaimed: true, balanceUnits: preflight.balance_units }
    }

    return transaction(this.database, () => {
      const order = findOrder()
      if (order?.topup_intent_id && order.status === 'claimed') {
        return {
          alreadyClaimed: true,
          toppedUp: true,
          balanceUnits: order.balance_units,
          keyPrefix: order.key_prefix,
          creditUnits: order.units,
        }
      }
      const state = claimState(order, keyHash)
      if (state === 'claimed') {
        return { alreadyClaimed: true, balanceUnits: order.balance_units }
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
      this.database.prepare(`
        INSERT INTO credit_grants (
          id, credit_order_id, api_key_id, units, remaining_units,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        `grt_${randomUUID()}`,
        order.id,
        apiKeyId,
        order.units,
        order.units,
        timestamp,
        timestamp
      )

      return {
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
      SELECT
        api_keys.id,
        api_keys.key_prefix,
        api_keys.balance_units,
        api_keys.status,
        api_key_suspensions.reason AS suspension_reason
      FROM api_keys
      LEFT JOIN api_key_suspensions ON api_key_suspensions.api_key_id = api_keys.id
      WHERE api_keys.key_hash = ?
    `).get(hashApiKey(apiKey))
    if (!record || record.status !== 'active') {
      throw new CreditError('invalid_api_key', 'invalid prepaid API key', 401)
    }
    if (record.suspension_reason) {
      throw new CreditError(
        'api_key_suspended',
        'prepaid API key is suspended pending payment review',
        403
      )
    }
    return {
      apiKeyId: record.id,
      keyPrefix: record.key_prefix,
      balanceUnits: record.balance_units,
    }
  }

  createTopUpIntent(apiKey) {
    this.inspectApiKey(apiKey)
    return transaction(this.database, () => {
      const key = this.inspectApiKey(apiKey)
      const timestamp = now()
      const intentId = `topup_${randomBytes(32).toString('base64url')}`
      this.database.prepare(`
        INSERT INTO topup_intents (id, api_key_id, created_at)
        VALUES (?, ?, ?)
      `).run(intentId, key.apiKeyId, timestamp)
      return {
        intentId,
        keyPrefix: key.keyPrefix,
      }
    })
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
      if (existing?.state === 'released') {
        this.database.prepare(`
          UPDATE credit_reservations
          SET endpoint = ?, units = ?, state = 'reserved', updated_at = ?
          WHERE api_key_id = ? AND request_id = ?
        `).run(endpoint, units, timestamp, key.apiKeyId, requestId)
        this.database.prepare(`
          DELETE FROM reservation_grants WHERE api_key_id = ? AND request_id = ?
        `).run(key.apiKeyId, requestId)
      } else {
        this.database.prepare(`
          INSERT INTO credit_reservations (
            api_key_id, request_id, endpoint, units, state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'reserved', ?, ?)
        `).run(key.apiKeyId, requestId, endpoint, units, timestamp, timestamp)
      }

      let unitsToAllocate = units
      const grants = this.database.prepare(`
        SELECT id, remaining_units
        FROM credit_grants
        WHERE api_key_id = ? AND status = 'active' AND remaining_units > 0
        ORDER BY created_at, rowid
      `).all(key.apiKeyId)
      for (const grant of grants) {
        if (unitsToAllocate === 0) break
        const allocated = Math.min(unitsToAllocate, grant.remaining_units)
        this.database.prepare(`
          UPDATE credit_grants
          SET remaining_units = remaining_units - ?, updated_at = ?
          WHERE id = ? AND status = 'active' AND remaining_units >= ?
        `).run(allocated, timestamp, grant.id, allocated)
        this.database.prepare(`
          INSERT INTO reservation_grants (
            api_key_id, request_id, credit_grant_id, units
          ) VALUES (?, ?, ?, ?)
        `).run(key.apiKeyId, requestId, grant.id, allocated)
        unitsToAllocate -= allocated
      }
      if (unitsToAllocate !== 0) {
        throw new Error('API key balance exceeds its active credit grants')
      }
      this.database.prepare(`
        UPDATE api_keys SET balance_units = balance_units - ? WHERE id = ?
      `).run(units, key.apiKeyId)

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
      const timestamp = now()
      this.database.prepare(`
        UPDATE credit_reservations SET state = ?, updated_at = ?
        WHERE api_key_id = ? AND request_id = ? AND state = 'reserved'
      `).run(nextState, timestamp, apiKeyId, requestId)
      if (!succeeded) {
        const allocations = this.database.prepare(`
          SELECT credit_grant_id, units
          FROM reservation_grants
          WHERE api_key_id = ? AND request_id = ?
        `).all(apiKeyId, requestId)
        let restoredUnits = 0
        for (const allocation of allocations) {
          const restored = this.database.prepare(`
            UPDATE credit_grants
            SET remaining_units = remaining_units + ?, updated_at = ?
            WHERE id = ? AND status = 'active'
          `).run(allocation.units, timestamp, allocation.credit_grant_id)
          if (restored.changes === 1) restoredUnits += allocation.units
        }
        if (restoredUnits > 0) {
          this.database.prepare(`
            UPDATE api_keys SET balance_units = balance_units + ? WHERE id = ?
          `).run(restoredUnits, apiKeyId)
        }
        this.database.prepare(`
          DELETE FROM reservation_grants WHERE api_key_id = ? AND request_id = ?
        `).run(apiKeyId, requestId)
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
  const activationConfigured = [
    required.paymentLinkId,
    required.paymentLinkUrl,
    required.webhookSecret,
  ].filter(Boolean).length
  if (activationConfigured === 0) return null
  if (
    activationConfigured !== 3 ||
    !required.databasePath
  ) {
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
    createTopUpCheckout(apiKey) {
      const intent = ledger.createTopUpIntent(apiKey)
      const checkoutUrl = new URL(paymentLinkUrl)
      checkoutUrl.searchParams.set('client_reference_id', intent.intentId)
      return {
        checkoutUrl: checkoutUrl.toString(),
        keyPrefix: intent.keyPrefix,
        units: CREDIT_PACKAGE_UNITS,
        amountCents: CREDIT_PACKAGE_CENTS,
      }
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
        clientReferenceId: typeof session.client_reference_id === 'string'
          ? session.client_reference_id
          : null,
      })
    },
    close() {
      ledger.close()
    },
  }
}
