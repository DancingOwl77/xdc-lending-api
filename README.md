[README (2).md](https://github.com/user-attachments/files/29753852/README.2.md)
# LendWatch XDC

**The lending intelligence layer for AI agents on XDC Network.**

An x402 pay-per-call API that reads live lending data directly from **all Silo Finance V3 markets** on XDC mainnet. Rates, wallet positions, collateral parameters, borrow simulations, and liquidation monitoring — settled per call in USDC, no accounts, no API keys.

Listed on the [XDC AI marketplace](https://xdcai.tech/marketplace) · DeFi · 8 endpoints.

---

## Live Endpoints

| Method | Path | Price | Description |
|--------|------|-------|-------------|
| GET | `/health` | Free | Service status |
| GET | `/info` | Free | Full endpoint catalogue |
| GET | `/silo/markets` | Free | All discovered Silo markets on XDC |
| GET | `/rates` | $0.0025 | Lending rates across all Silo markets + XDC DeFi |
| GET | `/rates/:protocol` | $0.0015 | Single protocol rates (e.g. `silo`) |
| GET | `/collateral` | $0.0025 | Collateral assets and on-chain LTV ratios (all markets) |
| GET | `/position/:wallet` | $0.005 | Wallet loan health, positions, and USD-valued health factor |
| POST | `/simulate/borrow` | $0.005 | Simulate a borrow with live prices and real LTVs |
| POST | `/simulate/liquidation` | $0.005 | Simulate liquidation risk at a given price drop |
| GET | `/liquidations/recent` | $0.004 | Recent liquidation events (on-chain log scan, all markets) |
| GET | `/best-rate/:asset` | $0.0025 | Best supply and borrow rate for an asset across all markets |

All prices in USDC on XDC mainnet. Payments settle via the x402 protocol.

---

## Full Silo-on-XDC Coverage

LendWatch reads **every Silo Finance V3 market** deployed on XDC — discovered automatically via the Silo factory's on-chain events, not hardcoded. Current markets include:

- WXDC / USDC (multiple markets)
- scrvUSD / USDC
- ynRWAx / USDC (RWA-backed)
- USDC / wsrUSD

New markets are picked up automatically as Silo deploys them. Every endpoint serves real data read directly from the market contracts — no mock data, no stale aggregation.

For each market:
- **Rates:** borrow/supply APR from the interest rate model contract
- **Collateral:** maxLTV, liquidation threshold, and liquidation fee from the market config
- **Utilization & liquidity:** supplied vs borrowed, read live
- **Positions:** collateral, protected collateral, and debt from ERC-4626 share tokens, valued in USD
- **Liquidations:** scanned from on-chain event logs

Market discovery is cached 30 min; per-market data 60s; liquidation scans 5 min. Graceful fallbacks throughout.

---

## How Payment Works (x402)

```
Agent → GET /rates
Server → 402 Payment Required { payTo, amount, asset: USDC, network: xdc }
Agent → signs EIP-3009 USDC authorization (gasless)
Agent → GET /rates + X-Payment header
Server → verifies via facilitator, settles on-chain, returns data
```

The agent never pays gas — a facilitator relays the settlement. Payment settles in USDC to the provider wallet.

---

## Tech Stack

- **Runtime:** Node.js / Express
- **Payments:** x402 (EIP-3009 USDC transfers on XDC)
- **On-chain reads:** XDC JSON-RPC (`eth_call`, `eth_getLogs`)
- **Protocol:** Silo Finance V3 (multi-market, factory-discovered)
- **Price feeds:** CoinGecko (XDC/WXDC, USDC)
- **Hosting:** Render (auto-deploy from GitHub)
- **Security:** rate limiting, validate-before-charge on all parameterized endpoints

---

## Running Locally

```bash
git clone https://github.com/DancingOwl77/xdc-lending-api
cd xdc-lending-api
npm install

export RECEIVER_WALLET=0xYourXDCWallet
export NODE_ENV=production
node server.js
```

Test the payment challenge:
```bash
curl https://xdc-lending-api.onrender.com/rates
# → 402 Payment Required (correct — agent must pay first)

curl https://xdc-lending-api.onrender.com/info
# → 200 OK, full catalogue (free)
```

See all live Silo markets (free):
```bash
curl https://xdc-lending-api.onrender.com/silo/markets
```

---

## Configuration

| Env var | Description |
|---------|-------------|
| `RECEIVER_WALLET` | XDC address that receives USDC payments |
| `NODE_ENV` | Set to `production` to enforce payment verification |
| `XDC_RPC` | (optional) XDC RPC URL, defaults to public endpoint |
| `SILO_MARKET` | (optional) reference Silo market, defaults to the WXDC/USDC market |

---

## License

MIT
