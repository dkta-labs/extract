import { createWalletClient, http, publicActions } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { createPaymentHeader, selectPaymentRequirements } from 'x402/client'

const PRIVATE_KEY = process.env.TEST_PRIVATE_KEY
const account = privateKeyToAccount(PRIVATE_KEY)
const walletClient = createWalletClient({
  account, chain: base, transport: http('https://mainnet.base.org'),
}).extend(publicActions)

const TEST_URL = 'https://paulgraham.com/greatwork.html'
const API = 'https://extract.dkta.dev/v1/extract'

// Step 1: get 402
const r1 = await fetch(`${API}?url=${encodeURIComponent(TEST_URL)}`)
const body402 = await r1.json()
console.log('402 body:', JSON.stringify(body402, null, 2))

// Step 2: build payment header
const selected = selectPaymentRequirements(body402.accepts, 'exact', 'base')
console.log('\nSelected requirement:', JSON.stringify(selected, null, 2))
const paymentHeader = await createPaymentHeader(walletClient, 1, selected)
console.log('\nPayment header (truncated):', paymentHeader.slice(0, 100) + '...')

// Step 3: call facilitator directly to verify
const facilitatorUrl = 'https://x402.org/facilitator'
console.log('\nCalling facilitator verify at', facilitatorUrl)
const verifyRes = await fetch(`${facilitatorUrl}/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    payment: paymentHeader,
    paymentRequirements: selected,
  })
})
console.log('Facilitator verify status:', verifyRes.status)
const verifyBody = await verifyRes.text()
console.log('Facilitator verify body:', verifyBody)
