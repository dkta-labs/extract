# extract-mcp — MCP Server for extract.dkta.dev

This MCP server exposes [extract.dkta.dev](https://extract.dkta.dev) as an AI tool, allowing any MCP-compatible client (Claude Desktop, Cursor, etc.) to extract clean, readable text from any URL. Each call costs **$0.001 USDC** paid automatically via the [x402 protocol](https://x402.org) on Base mainnet.

## Prerequisites

- Node.js 18+
- An EVM wallet private key with a small amount of USDC on **Base mainnet** (for paying per-call fees)

## Setup

1. Install dependencies (already done if you're reading this from `/opt/extract`):
   ```bash
   npm install
   ```

2. Export your agent wallet private key:
   ```bash
   export AGENT_PRIVATE_KEY=0xyour_private_key_here
   ```

---

## Adding to Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "extract": {
      "command": "node",
      "args": ["/opt/extract/mcp.js"],
      "env": {
        "AGENT_PRIVATE_KEY": "0xyour_private_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. You should see the **extract_webpage** tool available.

---

## Adding to Cursor

Edit `~/.cursor/mcp.json` (or via **Cursor → Settings → MCP**):

```json
{
  "mcpServers": {
    "extract": {
      "command": "node",
      "args": ["/opt/extract/mcp.js"],
      "env": {
        "AGENT_PRIVATE_KEY": "0xyour_private_key_here"
      }
    }
  }
}
```

Restart Cursor. The tool will appear in Cursor's agent tool list.

---

## Tool Reference

### `extract_webpage`

**Description:** Extract clean readable text from any URL. Costs $0.001 USDC per call via x402 on Base mainnet.

**Input:**
| Parameter | Type   | Required | Description              |
|-----------|--------|----------|--------------------------|
| `url`     | string | ✅        | The URL to extract content from |

**Example prompt:**
> "Extract the content from https://example.com/article"

---

## How It Works

1. The MCP client calls `extract_webpage` with a URL.
2. The server sends a GET request to `https://extract.dkta.dev/v1/extract?url=<url>`.
3. If the server responds with an HTTP 402 (Payment Required), `x402-fetch` automatically signs and submits a $0.001 USDC payment on Base mainnet using your `AGENT_PRIVATE_KEY`.
4. The request is retried with payment proof, and the extracted text is returned to the client.

---

## Security Note

Keep your `AGENT_PRIVATE_KEY` secure. Use a dedicated wallet with only small USDC balances for agent use — do not reuse a personal wallet.
