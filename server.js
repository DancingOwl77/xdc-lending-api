/**
 * XDC Lending API — x402 Spec-Compliant for xdcai.tech/marketplace
 *
 * Matches the exact wire format required by xdcai.tech/providers:
 *  - network:  "xdc"  (not "xdc-mainnet")
 *  - asset:    0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1  (USDC on XDC mainnet)
 *  - decimals: 6  → price in atomic units ($0.01 = "10000")
 *  - payTo:    your 0x address (set via RECEIVER_WALLET env var)
 *  - facilitator: https://xdc-mcp.vercel.app/api/facilitator
 *  - extra:    { name: "USDC", version: "2" }
 *
 * Endpoints
 * ─────────────────────────────────────────────────────────────────
 *  FREE   GET /health          — service status
 *  FREE   GET /info            — full endpoint catalogue
 *  PAID   GET /rates           — $0.005  all protocol rates
 *  PAID   GET /rates/:protocol — $0.003  single protocol
 *  PAID   GET /collateral      — $0.005  collateral assets + LTV
 *  PAID   GET /position/:wallet— $0.010  wallet health & positions
 *  PAID   POST /simulate/borrow— $0.010  borrow simulation
 *  PAID   POST /simulate/liquidation — $0.010  liquidation scenario
 *  PAID   GET /liquidations/recent   — $0.008  recent events
 *  PAID   GET /best-rate/:asset      — $0.005  best rate for asset
 */

const express = require('express');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIG ────────────────────────────────────────────────────────────────────

const PORT             = process.env.PORT || 3000;
const RECEIVER_WALLET  = process.env.RECEIVER_WALLET || '0xYourReceivingAddressHere';
const FACILITATOR_URL  = 'https://xdc-mcp.vercel.app/api/facilitator';

// USDC on XDC mainnet (6 decimals)
const USDC_XDC = '0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1';

// Convert $ price → atomic USDC units (string, as spec requires)
const toAtomic = (usd) => String(Math.round(usd * 1_000_000));

// ── ROUTE PRICE MAP ───────────────────────────────────────────────────────────

const ROUTES = {
  'GET /rates':                   { price: 0.005, capability: 'lending.rates',       description: 'All XDC protocol lending rates'        },
  'GET /rates/:protocol':         { price: 0.003, capability: 'lending.rates.single',description: 'Single protocol lending rates'          },
  'GET /collateral':              { price: 0.005, capability: 'lending.collateral',  description: 'Collateral assets and LTV ratios'       },
  'GET /position/:wallet':        { price: 0.010, capability: 'lending.position',    description: 'Wallet loan health and positions'       },
  'POST /simulate/borrow':        { price: 0.010, capability: 'lending.simulate.borrow',      description: 'Simulate a borrow'            },
  'POST /simulate/liquidation':   { price: 0.010, capability: 'lending.simulate.liquidation', description: 'Simulate liquidation risk'    },
  'GET /liquidations/recent':     { price: 0.008, capability: 'lending.liquidations',description: 'Recent liquidation events'             },
  'GET /best-rate/:asset':        { price: 0.005, capability: 'lending.bestrate',   description: 'Best supply and borrow rate for asset'  },
};

// ── x402 MIDDLEWARE (spec-compliant) ─────────────────────────────────────────
//
// xdcai.tech providers doc specifies exact 402 body shape.
// This middleware:
//   1. No X-PAYMENT header  → return 402 with correct accepts[]
//   2. X-PAYMENT present    → forward to facilitator /verify then /settle
//   3. Settlement succeeds  → attach X-Payment-Response header, call next()

function x402(routeKey) {
  const { price, description } = ROUTES[routeKey];
  const maxAmountRequired = toAtomic(price);

  return async (req, res, next) => {
    const payment = req.headers['x-payment'];

    if (!payment) {
      // Spec-compliant 402 — every field must be present
      return res.status(402).json({
        x402Version: 1,
        accepts: [
          {
            scheme:             'exact',
            network:            'xdc',
            maxAmountRequired,
            resource:           `${req.protocol}://${req.get('host')}${req.originalUrl}`,
            description,
            mimeType:           'application/json',
            payTo:              RECEIVER_WALLET,
            asset:              USDC_XDC,
            maxTimeoutSeconds:  60,
            extra:              { name: 'USDC', version: '2' },
          },
        ],
      });
    }

    // Verify with facilitator
    try {
      const axios = require('axios');

      const verifyRes = await axios.post(`${FACILITATOR_URL}/verify`, {
        x402Version: 1,
        scheme:    'exact',
        network:   'xdc',
        payload:   payment,
        resource:  `${req.protocol}://${req.get('host')}${req.originalUrl}`,
        payTo:     RECEIVER_WALLET,
        asset:     USDC_XDC,
        maxAmountRequired,
        maxTimeoutSeconds: 60,
        extra: { name: 'USDC', version: '2' },
      }, { timeout: 8000 });

      if (!verifyRes.data?.isValid) {
        return res.status(402).json({ error: 'Payment invalid', detail: verifyRes.data });
      }

      // Settle
      const settleRes = await axios.post(`${FACILITATOR_URL}/settle`, {
        x402Version: 1,
        scheme:    'exact',
        network:   'xdc',
        payload:   payment,
        resource:  `${req.protocol}://${req.get('host')}${req.originalUrl}`,
        payTo:     RECEIVER_WALLET,
        asset:     USDC_XDC,
        maxAmountRequired,
        maxTimeoutSeconds: 60,
        extra: { name: 'USDC', version: '2' },
      }, { timeout: 10000 });

      res.set('X-Payment-Response', Buffer.from(JSON.stringify({
        success: true,
        txHash:  settleRes.data?.txHash || 'settled',
        network: 'xdc',
        amount:  maxAmountRequired,
      })).toString('base64'));

      next();

    } catch (err) {
      // Facilitator unreachable — still serve in dev; block in production
      if (process.env.NODE_ENV === 'production') {
        return res.status(402).json({ error: 'Payment verification failed', detail: err.message });
      }
      // DEV MODE: skip facilitator verification to allow local testing
      console.warn('[DEV] Facilitator unreachable — bypassing verification:', err.message);
      next();
    }
  };
}

// ── DATA FUNCTIONS ────────────────────────────────────────────────────────────
// Replace these with live XDC RPC / subgraph calls before listing.
// Each function maps to one or more endpoints.

function getLendingRates() {
  return {
    timestamp: new Date().toISOString(),
    network:   'XDC Mainnet',
    source:    'XDC Lending API v1.0 — replace with live RPC reads',
    protocols: [
      {
        protocol: 'Raze Finance',
        type:     'USDC Yield',
        assets: [
          { asset: 'USDC', supplyAPY: 4.82, borrowAPY: null,  utilization: 0.71, tvlUSD: 2_400_000 },
        ],
      },
      {
        protocol: 'XSwap Protocol',
        type:     'DEX + Lending',
        assets: [
          { asset: 'XDC/USDC LP', supplyAPY: 12.4, borrowAPY: null, utilization: 0.58, tvlUSD: 890_000 },
          { asset: 'WXDC',        supplyAPY: 6.1,  borrowAPY: 9.3,  utilization: 0.65, tvlUSD: 1_100_000 },
        ],
      },
      {
        protocol: 'Credefi',
        type:     'RWA-Backed Lending',
        assets: [
          { asset: 'USDC', supplyAPY: 8.5,  borrowAPY: 14.2, utilization: 0.60, tvlUSD: 560_000 },
          { asset: 'USDT', supplyAPY: 7.9,  borrowAPY: 13.8, utilization: 0.55, tvlUSD: 320_000 },
        ],
      },
      {
        protocol: 'Curve Finance (XDC)',
        type:     'Stablecoin AMM',
        assets: [
          { asset: 'USDC/USDT', supplyAPY: 3.2, borrowAPY: null, utilization: 0.82, tvlUSD: 4_100_000 },
        ],
      },
    ],
  };
}

function getCollateral() {
  return {
    timestamp: new Date().toISOString(),
    network:   'XDC Mainnet',
    assets: [
      { asset: 'XDC',  ltvRatio: 0.65, liquidationThreshold: 0.75, liquidationPenalty: 0.10, minCollateral: 100   },
      { asset: 'WXDC', ltvRatio: 0.65, liquidationThreshold: 0.75, liquidationPenalty: 0.10, minCollateral: 100   },
      { asset: 'USDC', ltvRatio: 0.85, liquidationThreshold: 0.90, liquidationPenalty: 0.05, minCollateral: 50    },
      { asset: 'USDT', ltvRatio: 0.85, liquidationThreshold: 0.90, liquidationPenalty: 0.05, minCollateral: 50    },
      { asset: 'WBTC', ltvRatio: 0.70, liquidationThreshold: 0.80, liquidationPenalty: 0.10, minCollateral: 0.001 },
      { asset: 'WETH', ltvRatio: 0.70, liquidationThreshold: 0.80, liquidationPenalty: 0.10, minCollateral: 0.01  },
    ],
    note: 'LTV ratios vary by protocol. Verify on-chain before transacting.',
  };
}

function getPosition(wallet) {
  const hf = 1.45 + Math.random() * 0.5;
  return {
    timestamp: new Date().toISOString(),
    wallet,
    network:   'XDC Mainnet',
    summary: {
      totalCollateralUSD: 12_450,
      totalBorrowedUSD:   5_820,
      netPositionUSD:     6_630,
      healthFactor:       +hf.toFixed(3),
      liquidationRisk:    hf < 1.2 ? 'HIGH' : hf < 1.5 ? 'MEDIUM' : 'LOW',
    },
    positions: [
      {
        protocol:   'Raze Finance',
        collateral: { asset: 'XDC',  amount: 45000, valueUSD: 7200 },
        borrowed:   { asset: 'USDC', amount: 4000,  valueUSD: 4000 },
        healthFactor:     +(hf + 0.2).toFixed(3),
        liquidationPrice: 0.089,
      },
      {
        protocol:   'XSwap Protocol',
        collateral: { asset: 'WETH', amount: 1.5,  valueUSD: 5250 },
        borrowed:   { asset: 'USDC', amount: 1820, valueUSD: 1820 },
        healthFactor:     +(hf - 0.1).toFixed(3),
        liquidationPrice: 2480,
      },
    ],
    alerts: hf < 1.3 ? ['⚠️ Health factor below 1.3 — consider adding collateral or repaying'] : [],
  };
}

function simulateBorrow({ collateralAsset, collateralAmount, borrowAsset, protocol }) {
  const ltv    = { XDC: 0.65, WETH: 0.70, WBTC: 0.70, USDC: 0.85 }[collateralAsset] || 0.65;
  const prices = { XDC: 0.16, WETH: 3500, WBTC: 68000, USDC: 1.0 };
  const colUSD = (prices[collateralAsset] || 1) * collateralAmount;
  const maxUSD = colUSD * ltv;
  return {
    timestamp: new Date().toISOString(),
    simulation: true,
    inputs: { collateralAsset, collateralAmount, borrowAsset, protocol },
    result: {
      collateralValueUSD:   +colUSD.toFixed(2),
      maxBorrowUSD:         +maxUSD.toFixed(2),
      maxBorrowAmount:      +(maxUSD / (prices[borrowAsset] || 1)).toFixed(6),
      ltvRatio:             ltv,
      recommendedBorrowUSD: +(maxUSD * 0.75).toFixed(2),
      healthFactorAtMax:    1.18,
      healthFactorAtRecommended: 1.55,
      estimatedAPY:         { borrow: 9.3, supply: 4.82 },
      liquidationPrice:     +((prices[collateralAsset] || 1) * 0.75).toFixed(4),
    },
    warning: maxUSD > 10000 ? 'Large borrow — keep health factor above 1.5' : null,
  };
}

function simulateLiquidation({ wallet, priceDropPercent }) {
  const drop      = priceDropPercent / 100;
  const currentHF = 1.45;
  const newHF     = currentHF * (1 - drop);
  return {
    timestamp:  new Date().toISOString(),
    simulation: true,
    wallet,
    scenario:   `${priceDropPercent}% collateral price drop`,
    result: {
      currentHealthFactor:    currentHF,
      projectedHealthFactor:  +newHF.toFixed(3),
      liquidated:             newHF < 1.0,
      atRisk:                 newHF < 1.2,
      estimatedLossUSD:       newHF < 1.0 ? 1240 : 0,
      liquidationPenaltyUSD:  newHF < 1.0 ? 580  : 0,
      recommendation:         newHF < 1.2
        ? 'Add collateral or repay ≥$1,500 USDC to restore a safe health factor'
        : 'Position is safe at this price level',
    },
  };
}

function getRecentLiquidations() {
  return {
    timestamp:             new Date().toISOString(),
    network:               'XDC Mainnet',
    period:                'Last 24 hours',
    totalLiquidations:     3,
    totalValueLiquidatedUSD: 42_800,
    events: [
      { txHash: '0xabc123…', protocol: 'Raze Finance',    collateralAsset: 'XDC',  collateralAmount: 185000, debtRepaidAsset: 'USDC', debtRepaid: 22400, penaltyUSD: 2240, timestamp: new Date(Date.now()-3_600_000).toISOString() },
      { txHash: '0xdef456…', protocol: 'XSwap Protocol',  collateralAsset: 'WETH', collateralAmount: 3.2,    debtRepaidAsset: 'USDC', debtRepaid: 8900,  penaltyUSD: 890,  timestamp: new Date(Date.now()-7_200_000).toISOString() },
      { txHash: '0xghi789…', protocol: 'Credefi',         collateralAsset: 'XDC',  collateralAmount: 72000,  debtRepaidAsset: 'USDT', debtRepaid: 11500, penaltyUSD: 1150, timestamp: new Date(Date.now()-18_000_000).toISOString() },
    ],
  };
}

function getBestRate(asset) {
  const data   = getLendingRates();
  const all    = data.protocols.flatMap(p =>
    p.assets
      .filter(a => a.asset.toUpperCase().includes(asset.toUpperCase()))
      .map(a => ({ ...a, protocol: p.protocol, type: p.type }))
  );
  if (!all.length) return { error: `No rates for: ${asset}`, available: ['USDC','USDT','XDC','WXDC','WBTC','WETH'] };
  const bestSupply  = all.reduce((a, b) => (a.supplyAPY||0) > (b.supplyAPY||0) ? a : b);
  const borrowable  = all.filter(a => a.borrowAPY);
  const bestBorrow  = borrowable.length ? borrowable.reduce((a, b) => a.borrowAPY < b.borrowAPY ? a : b) : null;
  return {
    timestamp: new Date().toISOString(),
    asset:     asset.toUpperCase(),
    bestSupply:  { protocol: bestSupply.protocol, apy: bestSupply.supplyAPY, tvlUSD: bestSupply.tvlUSD },
    bestBorrow:  bestBorrow ? { protocol: bestBorrow.protocol, apy: bestBorrow.borrowAPY, tvlUSD: bestBorrow.tvlUSD } : null,
    allRates:    all,
  };
}

// ── FREE ROUTES ───────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({
  status: 'ok', service: 'XDC Lending API', version: '1.0.0',
  network: 'xdc', timestamp: new Date().toISOString(),
}));

app.get('/info', (_, res) => res.json({
  id:          'xdc-lending-api',
  name:        'XDC Lending API',
  description: 'Pay-per-call lending data for AI agents on XDC Network. Rates, positions, collateral, simulations, liquidations.',
  version:     '1.0.0',
  network:     'xdc',
  mcpUrl:      null,
  payment: {
    protocol:    'x402',
    asset:       USDC_XDC,
    network:     'xdc',
    decimals:    6,
    facilitator: FACILITATOR_URL,
    payTo:       RECEIVER_WALLET,
  },
  services: Object.entries(ROUTES).map(([key, val]) => {
    const [method, ...pathParts] = key.split(' ');
    return {
      url:          `https://your-api-url.com${pathParts.join(' ')}`,
      method,
      priceUSDC:    val.price.toFixed(3),
      capability:   val.capability,
      description:  val.description,
    };
  }),
  tags: ['lending', 'defi', 'xdc', 'rates', 'positions', 'liquidations'],
}));

// ── PAID ROUTES ───────────────────────────────────────────────────────────────

app.get('/rates',
  x402('GET /rates'),
  (_, res) => res.json(getLendingRates())
);

app.get('/rates/:protocol',
  x402('GET /rates/:protocol'),
  (req, res) => {
    const data  = getLendingRates();
    const found = data.protocols.find(p => p.protocol.toLowerCase().includes(req.params.protocol.toLowerCase()));
    if (!found) return res.status(404).json({ error: `Protocol not found: ${req.params.protocol}`, available: data.protocols.map(p => p.protocol) });
    res.json({ timestamp: data.timestamp, network: data.network, protocol: found });
  }
);

app.get('/collateral',
  x402('GET /collateral'),
  (_, res) => res.json(getCollateral())
);

app.get('/position/:wallet',
  x402('GET /position/:wallet'),
  (req, res) => {
    if (!req.params.wallet || req.params.wallet.length < 10)
      return res.status(400).json({ error: 'Invalid wallet address' });
    res.json(getPosition(req.params.wallet));
  }
);

app.post('/simulate/borrow',
  x402('POST /simulate/borrow'),
  (req, res) => {
    const { collateralAsset, collateralAmount, borrowAsset } = req.body;
    if (!collateralAsset || !collateralAmount || !borrowAsset)
      return res.status(400).json({
        error: 'Missing required fields',
        required: { collateralAsset: 'XDC|WETH|WBTC|USDC', collateralAmount: 'number', borrowAsset: 'USDC|USDT', protocol: 'optional' },
      });
    res.json(simulateBorrow({ ...req.body, collateralAmount: Number(collateralAmount) }));
  }
);

app.post('/simulate/liquidation',
  x402('POST /simulate/liquidation'),
  (req, res) => {
    const { wallet, priceDropPercent } = req.body;
    if (!wallet || priceDropPercent === undefined)
      return res.status(400).json({ error: 'Missing required fields', required: { wallet: 'string', priceDropPercent: 'number 0-100' } });
    res.json(simulateLiquidation({ wallet, priceDropPercent: Number(priceDropPercent) }));
  }
);

app.get('/liquidations/recent',
  x402('GET /liquidations/recent'),
  (_, res) => res.json(getRecentLiquidations())
);

app.get('/best-rate/:asset',
  x402('GET /best-rate/:asset'),
  (req, res) => res.json(getBestRate(req.params.asset))
);

// ── START ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nXDC Lending API  →  http://localhost:${PORT}`);
  console.log(`Receiver wallet  →  ${RECEIVER_WALLET}`);
  console.log(`Facilitator      →  ${FACILITATOR_URL}`);
  console.log(`Mode             →  ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = app;
