import { createWalletClient, http, publicActions } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { createPaymentHeader, selectPaymentRequirements } from 'x402/client'

const PRIVATE_KEY = process.env.TEST_PRIVATE_KEY
if (!PRIVATE_KEY) { console.error('TEST_PRIVATE_KEY required'); process.exit(1) }

const TEST_URL = 'https://paulgraham.com/greatwork.html'
const API = 'https://extract.dkta.dev/v1/extract'

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY)
  console.log('Agent wallet:', account.address)

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http('https://mainnet.base.org'),
  }).extend(publicActions)

  // Check USDC balance
  const usdc = await walletClient.readContract({
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    abi: [{ name: 'balanceOf', type: 'function', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }],
    functionName: 'balanceOf',
    args: [account.address],
  })
  console.log(`USDC balance: $${(Number(usdc) / 1e6).toFixed(4)}`)

  // Step 1: hit without payment → expect 402
  console.log('\n1. Hitting API without payment...')
  const r1 = await fetch(`${API}?url=${encodeURIComponent(TEST_URL)}`)
  console.log('   Status:', r1.status)
  if (r1.status !== 402) { console.error('Expected 402, got', r1.status); process.exit(1) }

  const body402 = await r1.json()
  console.log('   x402Version:', body402.x402Version)
  console.log('   payTo:', body402.accepts?.[0]?.payTo)
  console.log('   amount:', body402.accepts?.[0]?.maxAmountRequired, 'µUSDC')

  // Step 2: build payment header
  console.log('\n2. Signing payment...')
  const selected = selectPaymentRequirements(body402.accepts, 'exact', 'base')
  const paymentHeader = await createPaymentHeader(walletClient, 1, selected)
  console.log('   Payment header built ✓')

  // Step 3: retry with payment
  console.log('\n3. Retrying with X-PAYMENT header...')
  const r2 = await fetch(`${API}?url=${encodeURIComponent(TEST_URL)}`, {
    headers: { 'X-PAYMENT': paymentHeader },
  })
  console.log('   Status:', r2.status)

  if (r2.status === 200) {
    const data = await r2.json()
    console.log('\n✅ SUCCESS')
    console.log('   Title:', data.title)
    console.log('   Byline:', data.byline || '(none)')
    console.log('   Length:', data.length, 'chars')
    console.log('   Preview:', data.text?.slice(0, 150) + '...')
  } else {
    const err = await r2.text()
    console.error('\n❌ FAILED:', r2.status, err)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
