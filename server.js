/**
 * XDC Lending API — x402 Spec-Compliant for xdcai.tech/marketplace
 * v1.2.0 — rate limiting + live data via DeFiLlama with graceful fallback
 *
 * x402 wire format per docs.xdcai.tech:
 *   network "xdc" · USDC 0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1 (6 decimals)
 *   facilitator https://xdc-mcp.vercel.app/api/facilitator
 *   extra { name: "USDC", version: "2" }
 */

const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const { attachStats } = require('./stats');

const app = express();
app.set('trust proxy', 1); // trust Render's proxy only (required for correct https + rate limiting)
app.use(cors());
app.use(express.json());

// ── SECURITY: RATE LIMITING ──────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Max 120 requests/minute per IP.' },
}));

// ── CONFIG ────────────────────────────────────────────────────────────────────
const PORT            = process.env.PORT || 3000;
const RECEIVER_WALLET = process.env.RECEIVER_WALLET || '0xYourReceivingAddressHere';
const FACILITATOR_URL = 'https://xdc-mcp.vercel.app/api/facilitator';
const USDC_XDC        = '0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1';
const toAtomic        = (usd) => String(Math.round(usd * 1_000_000));

// ── ROUTE PRICE MAP ───────────────────────────────────────────────────────────
const ROUTES = {
  'GET /rates':                 { price: 0.005, description: 'All XDC protocol lending rates' },
  'GET /rates/:protocol':       { price: 0.003, description: 'Single protocol lending rates' },
  'GET /collateral':            { price: 0.005, description: 'Collateral assets and LTV ratios' },
  'GET /position/:wallet':      { price: 0.010, description: 'Wallet loan health and positions' },
  'POST /simulate/borrow':      { price: 0.010, description: 'Simulate a borrow' },
  'POST /simulate/liquidation': { price: 0.010, description: 'Simulate liquidation risk' },
  'GET /liquidations/recent':   { price: 0.008, description: 'Recent liquidation events' },
  'GET /best-rate/:asset':      { price: 0.005, description: 'Best supply/borrow rate for asset' },
};

// ── STATS + DASHBOARD ─────────────────────────────────────────────────────────
attachStats(app, {
  routes: Object.entries(ROUTES).map(([k, v]) => ({ endpoint: k, priceUSDC: v.price, description: v.description })),
  wallet: RECEIVER_WALLET,
  usdcContract: USDC_XDC,
  priceOf: (key) => ROUTES[key]?.price || 0,
});

app.get('/dashboard', (_, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));

// ── x402 MIDDLEWARE ───────────────────────────────────────────────────────────
function x402(routeKey) {
  const { price, description } = ROUTES[routeKey];
  const maxAmountRequired = toAtomic(price);

  return async (req, res, next) => {
    const payment = req.headers['x-payment'];

    if (!payment) {
      return res.status(402).json({
        x402Version: 1,
        accepts: [{
          scheme: 'exact',
          network: 'xdc',
          maxAmountRequired,
          resource: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
          description,
          mimeType: 'application/json',
          payTo: RECEIVER_WALLET,
          asset: USDC_XDC,
          maxTimeoutSeconds: 60,
          extra: { name: 'USDC', version: '2' },
        }],
      });
    }

    try {
      const body = {
        x402Version: 1, scheme: 'exact', network: 'xdc',
        payload: payment,
        resource: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
        payTo: RECEIVER_WALLET, asset: USDC_XDC,
        maxAmountRequired, maxTimeoutSeconds: 60,
        extra: { name: 'USDC', version: '2' },
      };

      const verifyRes = await axios.post(`${FACILITATOR_URL}/verify`, body, { timeout: 8000 });
      if (!verifyRes.data?.isValid) {
        return res.status(402).json({ error: 'Payment invalid', detail: verifyRes.data });
      }

      const settleRes = await axios.post(`${FACILITATOR_URL}/settle`, body, { timeout: 10000 });

      res.set('X-Payment-Response', Buffer.from(JSON.stringify({
        success: true,
        txHash: settleRes.data?.txHash || 'settled',
        network: 'xdc',
        amount: maxAmountRequired,
      })).toString('base64'));

      next();
    } catch (err) {
      // SECURITY: never serve paid content on verification failure.
      return res.status(402).json({ error: 'Payment verification failed', detail: err.message });
    }
  };
}

// ── LIVE DATA LAYER (DeFiLlama, 5-min cache, graceful fallback) ──────────────
let ratesCache = { data: null, fetchedAt: 0 };
const CACHE_TTL = 5 * 60 * 1000;

const FALLBACK_RATES = {
  timestamp: new Date().toISOString(),
  network: 'XDC Mainnet',
  dataSource: 'fallback-snapshot',
  protocols: [
    { protocol: 'XSwap Protocol', type: 'DEX Liquidity',
      assets: [{ asset: 'XDC/USDC LP', supplyAPY: 12.4, borrowAPY: null, utilization: null, tvlUSD: 890000 }] },
    { protocol: 'Curve Finance (XDC)', type: 'Stablecoin AMM',
      assets: [{ asset: 'USDC/USDT', supplyAPY: 3.2, borrowAPY: null, utilization: null, tvlUSD: 4100000 }] },
  ],
};

async function getLendingRates() {
  const now = Date.now();
  if (ratesCache.data && now - ratesCache.fetchedAt < CACHE_TTL) return ratesCache.data;

  try {
    // DeFiLlama yields API — public, no key. Filter to XDC chain pools.
    const resp = await axios.get('https://yields.llama.fi/pools', { timeout: 10000 });
    const xdcPools = (resp.data?.data || []).filter(p => p.chain === 'XDC');

    if (!xdcPools.length) throw new Error('no XDC pools returned');

    // Group pools by project
    const byProject = {};
    for (const p of xdcPools) {
      const name = p.project || 'unknown';
      byProject[name] = byProject[name] || [];
      byProject[name].push({
        asset: p.symbol,
        supplyAPY: p.apy != null ? +p.apy.toFixed(2) : null,
        borrowAPY: p.apyBaseBorrow != null ? +p.apyBaseBorrow.toFixed(2) : null,
        utilization: null,
        tvlUSD: p.tvlUsd != null ? Math.round(p.tvlUsd) : null,
        poolId: p.pool,
      });
    }

    const data = {
      timestamp: new Date().toISOString(),
      network: 'XDC Mainnet',
      dataSource: 'defillama-live',
      protocols: Object.entries(byProject).map(([project, assets]) => ({
        protocol: project,
        type: 'DeFi',
        assets,
      })),
    };

    ratesCache = { data, fetchedAt: now };
    return data;
  } catch (err) {
    console.warn('[rates] live fetch failed, serving fallback:', err.message);
    return { ...FALLBACK_RATES, timestamp: new Date().toISOString() };
  }
}

// ── STATIC/DERIVED DATA ───────────────────────────────────────────────────────
function getCollateral() {
  return {
    timestamp: new Date().toISOString(),
    network: 'XDC Mainnet',
    assets: [
      { asset: 'XDC',  ltvRatio: 0.65, liquidationThreshold: 0.75, liquidationPenalty: 0.10, minCollateral: 100 },
      { asset: 'WXDC', ltvRatio: 0.65, liquidationThreshold: 0.75, liquidationPenalty: 0.10, minCollateral: 100 },
      { asset: 'USDC', ltvRatio: 0.85, liquidationThreshold: 0.90, liquidationPenalty: 0.05, minCollateral: 50 },
      { asset: 'USDT', ltvRatio: 0.85, liquidationThreshold: 0.90, liquidationPenalty: 0.05, minCollateral: 50 },
      { asset: 'WBTC', ltvRatio: 0.70, liquidationThreshold: 0.80, liquidationPenalty: 0.10, minCollateral: 0.001 },
      { asset: 'WETH', ltvRatio: 0.70, liquidationThreshold: 0.80, liquidationPenalty: 0.10, minCollateral: 0.01 },
    ],
    note: 'Reference LTV parameters. Verify with the specific protocol on-chain before transacting.',
  };
}

function getPosition(wallet) {
  const hf = 1.45 + Math.random() * 0.5;
  return {
    timestamp: new Date().toISOString(),
    wallet, network: 'XDC Mainnet',
    dataSource: 'demo',
    summary: {
      totalCollateralUSD: 12450, totalBorrowedUSD: 5820, netPositionUSD: 6630,
      healthFactor: +hf.toFixed(3),
      liquidationRisk: hf < 1.2 ? 'HIGH' : hf < 1.5 ? 'MEDIUM' : 'LOW',
    },
    positions: [
      { protocol: 'Raze Finance', collateral: { asset: 'XDC', amount: 45000, valueUSD: 7200 },
        borrowed: { asset: 'USDC', amount: 4000, valueUSD: 4000 },
        healthFactor: +(hf + 0.2).toFixed(3), liquidationPrice: 0.089 },
      { protocol: 'XSwap Protocol', collateral: { asset: 'WETH', amount: 1.5, valueUSD: 5250 },
        borrowed: { asset: 'USDC', amount: 1820, valueUSD: 1820 },
        healthFactor: +(hf - 0.1).toFixed(3), liquidationPrice: 2480 },
    ],
    alerts: hf < 1.3 ? ['Health factor below 1.3 — consider adding collateral or repaying'] : [],
  };
}

function simulateBorrow({ collateralAsset, collateralAmount, borrowAsset, protocol }) {
  const ltv    = { XDC: 0.65, WETH: 0.70, WBTC: 0.70, USDC: 0.85 }[collateralAsset] || 0.65;
  const prices = { XDC: 0.16, WETH: 3500, WBTC: 68000, USDC: 1.0 };
  const colUSD = (prices[collateralAsset] || 1) * collateralAmount;
  const maxUSD = colUSD * ltv;
  return {
    timestamp: new Date().toISOString(), simulation: true,
    inputs: { collateralAsset, collateralAmount, borrowAsset, protocol },
    result: {
      collateralValueUSD: +colUSD.toFixed(2),
      maxBorrowUSD: +maxUSD.toFixed(2),
      maxBorrowAmount: +(maxUSD / (prices[borrowAsset] || 1)).toFixed(6),
      ltvRatio: ltv,
      recommendedBorrowUSD: +(maxUSD * 0.75).toFixed(2),
      healthFactorAtMax: 1.18,
      healthFactorAtRecommended: 1.55,
      liquidationPrice: +((prices[collateralAsset] || 1) * 0.75).toFixed(4),
    },
    warning: maxUSD > 10000 ? 'Large borrow — keep health factor above 1.5' : null,
  };
}

function simulateLiquidation({ wallet, priceDropPercent }) {
  const drop = priceDropPercent / 100;
  const currentHF = 1.45;
  const newHF = currentHF * (1 - drop);
  return {
    timestamp: new Date().toISOString(), simulation: true, wallet,
    scenario: `${priceDropPercent}% collateral price drop`,
    result: {
      currentHealthFactor: currentHF,
      projectedHealthFactor: +newHF.toFixed(3),
      liquidated: newHF < 1.0,
      atRisk: newHF < 1.2,
      estimatedLossUSD: newHF < 1.0 ? 1240 : 0,
      liquidationPenaltyUSD: newHF < 1.0 ? 580 : 0,
      recommendation: newHF < 1.2
        ? 'Add collateral or repay at least $1,500 USDC to restore a safe health factor'
        : 'Position is safe at this price level',
    },
  };
}

function getRecentLiquidations() {
  return {
    timestamp: new Date().toISOString(), network: 'XDC Mainnet',
    period: 'Last 24 hours', dataSource: 'demo',
    totalLiquidations: 3, totalValueLiquidatedUSD: 42800,
    events: [
      { txHash: '0xabc123…', protocol: 'Raze Finance',   collateralAsset: 'XDC',  collateralAmount: 185000, debtRepaidAsset: 'USDC', debtRepaid: 22400, penaltyUSD: 2240, timestamp: new Date(Date.now()-3600000).toISOString() },
      { txHash: '0xdef456…', protocol: 'XSwap Protocol', collateralAsset: 'WETH', collateralAmount: 3.2,    debtRepaidAsset: 'USDC', debtRepaid: 8900,  penaltyUSD: 890,  timestamp: new Date(Date.now()-7200000).toISOString() },
      { txHash: '0xghi789…', protocol: 'Credefi',        collateralAsset: 'XDC',  collateralAmount: 72000,  debtRepaidAsset: 'USDT', debtRepaid: 11500, penaltyUSD: 1150, timestamp: new Date(Date.now()-18000000).toISOString() },
    ],
  };
}

async function getBestRate(asset) {
  const data = await getLendingRates();
  const all  = data.protocols.flatMap(p =>
    p.assets
      .filter(a => (a.asset || '').toUpperCase().includes(asset.toUpperCase()))
      .map(a => ({ ...a, protocol: p.protocol }))
  );
  if (!all.length) return { error: `No rates for: ${asset}`, dataSource: data.dataSource, hint: 'Try USDC, USDT, XDC, WXDC' };
  const bestSupply = all.reduce((a, b) => (a.supplyAPY || 0) > (b.supplyAPY || 0) ? a : b);
  const borrowable = all.filter(a => a.borrowAPY);
  const bestBorrow = borrowable.length ? borrowable.reduce((a, b) => a.borrowAPY < b.borrowAPY ? a : b) : null;
  return {
    timestamp: new Date().toISOString(),
    asset: asset.toUpperCase(),
    dataSource: data.dataSource,
    bestSupply: { protocol: bestSupply.protocol, apy: bestSupply.supplyAPY, tvlUSD: bestSupply.tvlUSD },
    bestBorrow: bestBorrow ? { protocol: bestBorrow.protocol, apy: bestBorrow.borrowAPY, tvlUSD: bestBorrow.tvlUSD } : null,
    allRates: all,
  };
}

// ── FREE ROUTES ───────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.redirect('/info'));

app.get('/health', (_, res) => res.json({
  status: 'ok', service: 'XDC Lending API', version: '1.2.0',
  network: 'xdc', timestamp: new Date().toISOString(),
}));

app.get('/info', (_, res) => res.json({
  id: 'xdc-lending-api',
  name: 'XDC Lending API',
  description: 'Pay-per-call lending data for AI agents on XDC Network. Rates, positions, collateral, simulations, liquidations.',
  version: '1.2.0',
  network: 'xdc',
  payment: {
    protocol: 'x402', asset: USDC_XDC, network: 'xdc', decimals: 6,
    facilitator: FACILITATOR_URL, payTo: RECEIVER_WALLET,
  },
  services: Object.entries(ROUTES).map(([key, val]) => {
    const [method, path] = [key.split(' ')[0], key.split(' ').slice(1).join(' ')];
    return { url: `https://xdc-lending-api.onrender.com${path}`, method, priceUSDC: val.price.toFixed(3), description: val.description };
  }),
  tags: ['lending', 'defi', 'xdc', 'rates', 'positions', 'liquidations'],
}));

// ── PAID ROUTES ───────────────────────────────────────────────────────────────
app.get('/rates', x402('GET /rates'), async (_, res) => res.json(await getLendingRates()));

app.get('/rates/:protocol', x402('GET /rates/:protocol'), async (req, res) => {
  const data = await getLendingRates();
  const found = data.protocols.find(p => p.protocol.toLowerCase().includes(req.params.protocol.toLowerCase()));
  if (!found) return res.status(404).json({ error: `Protocol not found: ${req.params.protocol}`, available: data.protocols.map(p => p.protocol) });
  res.json({ timestamp: data.timestamp, network: data.network, dataSource: data.dataSource, protocol: found });
});

app.get('/collateral', x402('GET /collateral'), (_, res) => res.json(getCollateral()));

app.get('/position/:wallet', x402('GET /position/:wallet'), (req, res) => {
  if (!req.params.wallet || req.params.wallet.length < 10)
    return res.status(400).json({ error: 'Invalid wallet address' });
  res.json(getPosition(req.params.wallet));
});

app.post('/simulate/borrow', x402('POST /simulate/borrow'), (req, res) => {
  const { collateralAsset, collateralAmount, borrowAsset } = req.body;
  if (!collateralAsset || !collateralAmount || !borrowAsset)
    return res.status(400).json({ error: 'Missing required fields', required: { collateralAsset: 'XDC|WETH|WBTC|USDC', collateralAmount: 'number', borrowAsset: 'USDC|USDT' } });
  res.json(simulateBorrow({ ...req.body, collateralAmount: Number(collateralAmount) }));
});

app.post('/simulate/liquidation', x402('POST /simulate/liquidation'), (req, res) => {
  const { wallet, priceDropPercent } = req.body;
  if (!wallet || priceDropPercent === undefined)
    return res.status(400).json({ error: 'Missing required fields', required: { wallet: 'string', priceDropPercent: 'number 0-100' } });
  res.json(simulateLiquidation({ wallet, priceDropPercent: Number(priceDropPercent) }));
});

app.get('/liquidations/recent', x402('GET /liquidations/recent'), (_, res) => res.json(getRecentLiquidations()));

app.get('/best-rate/:asset', x402('GET /best-rate/:asset'), async (req, res) => res.json(await getBestRate(req.params.asset)));

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`XDC Lending API v1.2.0 → port ${PORT} | payTo ${RECEIVER_WALLET}`);
});

module.exports = app;
