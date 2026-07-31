import { createWalletClient, http, publicActions } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { x402Client } from '@x402/core/client'
import { registerExactEvmScheme } from '@x402/evm/exact/client'
import { wrapFetchWithPayment } from '@x402/fetch'

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

  const client = new x402Client()
  registerExactEvmScheme(client, { signer: account })
  const paidFetch = wrapFetchWithPayment(globalThis.fetch, client)

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

  const encodedChallenge = r1.headers.get('payment-required')
  if (!encodedChallenge) { console.error('Missing PAYMENT-REQUIRED header'); process.exit(1) }
  const challenge = JSON.parse(Buffer.from(encodedChallenge, 'base64').toString())
  console.log('   x402Version:', challenge.x402Version)
  console.log('   payTo:', challenge.accepts?.[0]?.payTo)
  console.log('   amount:', challenge.accepts?.[0]?.amount, 'µUSDC')
  console.log('   network:', challenge.accepts?.[0]?.network)

  // Step 2: pay and retry automatically
  console.log('\n2. Signing payment and retrying...')

  const r2 = await paidFetch(`${API}?url=${encodeURIComponent(TEST_URL)}`)
  console.log('   Status:', r2.status)

  if (r2.status === 200) {
    const data = await r2.json()
    console.log('\nSUCCESS')
    console.log('   Title:', data.title)
    console.log('   Byline:', data.byline || '(none)')
    console.log('   Length:', data.length, 'chars')
    console.log('   Preview:', data.content?.slice(0, 150) + '...')
  } else {
    const err = await r2.text()
    console.error('\nFAILED:', r2.status, err)
    process.exit(1)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
