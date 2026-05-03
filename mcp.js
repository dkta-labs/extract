import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { wrapFetchWithPayment } from 'x402-fetch';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const privateKey = process.env.AGENT_PRIVATE_KEY;
if (!privateKey) {
  console.error('Error: AGENT_PRIVATE_KEY environment variable is required');
  process.exit(1);
}

const account = privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);
const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http(),
});

const fetchWithPayment = wrapFetchWithPayment(fetch, walletClient);

const server = new Server(
  { name: 'extract-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'extract_webpage',
      description: 'Extract clean readable text from any URL. Costs $0.001 USDC per call via x402 on Base mainnet.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to extract content from',
          },
        },
        required: ['url'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'extract_webpage') {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const { url } = request.params.arguments;
  if (!url) {
    throw new Error('url argument is required');
  }

  const extractUrl = `https://extract.dkta.dev/v1/extract?url=${encodeURIComponent(url)}`;
  const response = await fetchWithPayment(extractUrl);

  if (!response.ok) {
    throw new Error(`Extract API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  return {
    content: [
      {
        type: 'text',
        text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
