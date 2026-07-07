[README (3).md](https://github.com/user-attachments/files/29762954/README.3.md)
# LendWatch XDC

**The lending intelligence layer for AI agents on XDC Network.**

An x402 pay-per-call API that reads live lending data directly from **every major lending protocol on XDC mainnet** — Silo Finance V3, PrimeFi, Fathom, and Morpho Blue. Rates, wallet positions, collateral parameters, borrow simulations, and liquidation monitoring — settled per call in USDC, no accounts, no API keys.

Listed on the [XDC AI marketplace](https://xdcai.tech/marketplace) · DeFi · 8 endpoints.

---

## Coverage — 4 Protocols, 17 Markets

Every endpoint reads real data directly from on-chain contracts. No mock data, no stale aggregation. Markets are discovered automatically (via factory/singleton events) and read live.

| Protocol | Architecture | Markets |
|----------|--------------|---------|
| Silo Finance V3 | Isolated lending | 8 (WXDC/USDC, scrvUSD, ynRWAx, wsrUSD) |
| PrimeFi | Aave v2 pooled | 5 (USDC, USDT, WXDC, PRFI, psXDC) |
| Fathom Lending | Aave v3 pooled | 2 (WXDC, USDC) |
| Morpho Blue | Singleton isolated | 2 funded (WXDC/USDC, wsrUSD/USDC) |

Cross-protocol rate comparison is the core value: an agent asking "best USDC supply rate on XDC" sees every protocol at once and can route to the optimal market.

---

## Live Endpoints

| Method | Path | Price | Description |
|--------|------|-------|-------------|
| GET | `/health` | Free | Service status |
| GET | `/info` | Free | Full endpoint catalogue |
| GET | `/silo/markets` | Free | All discovered Silo markets |
| GET | `/silo/test`, `/primefi/test`, `/fathom/test`, `/morpho/test` | Free | Per-protocol on-chain diagnostics |
| GET | `/rates` | $0.0025 | Lending rates across all protocols & markets |
| GET | `/rates/:protocol` | $0.0015 | Single protocol rates (e.g. `silo`, `primefi`, `fathom`, `morpho`) |
| GET | `/collateral` | $0.0025 | Collateral assets and on-chain LTV ratios (all protocols) |
| GET | `/position/:wallet` | $0.005 | Wallet loan health, positions, USD-valued health factor |
| POST | `/simulate/borrow` | $0.005 | Simulate a borrow with live prices and real LTVs |
| POST | `/simulate/liquidation` | $0.005 | Simulate liquidation risk at a given price drop |
| GET | `/liquidations/recent` | $0.004 | Recent liquidation events (on-chain log scan) |
| GET | `/best-rate/:asset` | $0.0025 | Best supply/borrow rate for an asset across all protocols |

All prices in USDC on XDC mainnet. Payments settle via the x402 protocol.

---

## What's Read On-Chain

For each protocol and market:
- **Rates:** borrow/supply APY from the interest rate model contracts
- **Collateral:** max LTV, liquidation threshold, liquidation fee/bonus from market configs
- **Utilization & liquidity:** supplied vs borrowed, live
- **Positions:** collateral, protected collateral, and debt (Silo), USD-valued via price feeds
- **Liquidations:** scanned from on-chain event logs

Every value traces to a contract call anyone can independently verify. Market discovery cached 30 min; per-market data 60s; liquidation scans 5 min. Graceful fallbacks throughout.

### Verified contract references

- Silo factory: `0xf81d90df1b63d48536e78564d24d5dd8f2be58ad`
- PrimeFi ProtocolDataProvider (Aave v2): `0x2E6bA568aaebadb4db3E018313ee34baD0328988`
- Fathom PoolDataProvider (Aave v3): `0x7fa488a5C88E9E35B0B86127Ec76B0c1F0933191`
- Morpho Blue singleton (XDC): `0xEa49B0fE898aF913A3826F9f462eE2cDcb854fD9`

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
- **Protocols:** Silo V3, PrimeFi (Aave v2), Fathom (Aave v3), Morpho Blue
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

See live protocol data (free diagnostics):
```bash
curl https://xdc-lending-api.onrender.com/silo/markets
curl https://xdc-lending-api.onrender.com/morpho/test
```

---

## Configuration

| Env var | Description |
|---------|-------------|
| `RECEIVER_WALLET` | XDC address that receives USDC payments |
| `NODE_ENV` | Set to `production` to enforce payment verification |
| `XDC_RPC` | (optional) XDC RPC URL, defaults to public endpoint |
| `SILO_MARKET` | (optional) reference Silo market address |
| `MORPHO_SINGLETON` | (optional) Morpho Blue singleton, defaults to XDC deployment |

---

## License

MIT
