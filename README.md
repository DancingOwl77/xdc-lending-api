# XDC Lending API — x402 Compatible

An x402 pay-per-call API for AI agents to query XDC Network lending protocols.
Built to be listed on [xdcai.tech/marketplace](https://xdcai.tech/marketplace).

---

## What This Is

AI agents funded via xdcai.tech can call this API to:
- Get live lending/borrowing rates across XDC DeFi protocols
- Check a wallet's loan health and liquidation risk
- Simulate borrow positions before executing
- Monitor recent liquidation events
- Find the best rate for any asset on XDC

Agents pay per call in USDC on XDC Network. No accounts, no API keys.

---

## Endpoints

| Method | Path | Price | Description |
|--------|------|-------|-------------|
| GET | /health | FREE | Service status |
| GET | /info | FREE | Full endpoint catalogue |
| GET | /rates | $0.005 | All protocol rates |
| GET | /rates/:protocol | $0.003 | Single protocol (raze\|xswap\|credefi\|curve) |
| GET | /collateral | $0.005 | Collateral assets & LTV ratios |
| GET | /position/:wallet | $0.010 | Wallet positions & health factor |
| POST | /simulate/borrow | $0.010 | Simulate a borrow |
| POST | /simulate/liquidation | $0.010 | Simulate liquidation at price drop % |
| GET | /liquidations/recent | $0.008 | Recent liquidation events |
| GET | /best-rate/:asset | $0.005 | Best rate for an asset |

---

## Quick Start

```bash
git clone https://github.com/your-handle/xdc-lending-api
cd xdc-lending-api
npm install

# Set your XDC wallet to receive USDC payments
export RECEIVER_WALLET=xdc742d...yourwallet

node server.js
```

Test the x402 flow:
```bash
# Should return 402 (correct — payment required)
curl http://localhost:3000/rates

# Should return 200 with full endpoint list (free)
curl http://localhost:3000/info
```

---

## Connecting to Live XDC Data

Replace the mock data functions in server.js with real on-chain reads:

```javascript
const { ethers } = require('ethers');
const provider = new ethers.JsonRpcProvider('https://rpc.xinfin.network');

// Example: read XSwap lending rates
const XSWAP_LENDING = '0x...contractAddress';
const abi = ['function getLendingRate(address asset) view returns (uint256)'];
const contract = new ethers.Contract(XSWAP_LENDING, abi, provider);

async function getLiveRate(asset) {
  const rate = await contract.getLendingRate(asset);
  return ethers.formatUnits(rate, 18); // returns APY as decimal
}
```

Data sources to integrate:
- **Raze Finance**: Read `supplyRate()` and `borrowRate()` from their lending pool contract
- **XSwap**: Query their subgraph at https://graph.xswap.io/subgraphs/name/xswap
- **Credefi**: Their API at https://api.credefi.finance/v1/rates
- **Curve on XDC**: Read pool contracts directly via XDC RPC

---

## Deploying

### Railway (easiest)
```bash
railway login
railway init
railway up
```

### Render
1. Connect your GitHub repo
2. Set env var: RECEIVER_WALLET=xdc...
3. Build command: npm install
4. Start command: node server.js

### VPS / Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm install
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
```

---

## Listing on xdcai.tech/marketplace

Once deployed, submit to https://xdcai.tech/providers with:
- Your API base URL
- The /info endpoint (auto-documents all endpoints + prices)
- Your XDC receiver wallet
- Category: DeFi / Lending

---

## Revenue Model

Every paid API call settles USDC directly to your wallet on XDC Network.
No platform fees, no middleman. You keep 100% of what agents pay.

Example at 100 calls/day:
- Average price: ~$0.007 per call
- Daily revenue: ~$0.70
- Monthly: ~$21

At 1,000 calls/day (multiple agents): ~$210/month
At 10,000 calls/day: ~$2,100/month

Revenue scales linearly with agent adoption on XDC.

---

## x402 Payment Flow

```
Agent → GET /rates
Server → 402 { payTo: xdc..., amount: 5000 (USDC micro), network: xdc-mainnet }
Agent → signs EIP-3009 authorization from xdcai.tech wallet
Agent → GET /rates + X-Payment: <base64 auth>
Server → verifies on-chain, returns 200 + lending data
```

No gas needed from agent — xdcai.tech relayer handles XDC gas.

---

## License

MIT
