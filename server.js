/**
 * XDC Lending API — x402 Spec-Compliant for xdcai.tech/marketplace
 * v1.5.1 — rate limiting + live data via DeFiLlama with graceful fallback
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
const silo = require('./silo');

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
  'GET /rates':                 { price: 0.0025, description: 'All XDC protocol lending rates' },
  'GET /rates/:protocol':       { price: 0.0015, description: 'Single protocol lending rates' },
  'GET /collateral':            { price: 0.0025, description: 'Collateral assets and LTV ratios' },
  'GET /position/:wallet':      { price: 0.005,  description: 'Wallet loan health and positions' },
  'POST /simulate/borrow':      { price: 0.005,  description: 'Simulate a borrow' },
  'POST /simulate/liquidation': { price: 0.005,  description: 'Simulate liquidation risk' },
  'GET /liquidations/recent':   { price: 0.004,  description: 'Recent liquidation events' },
  'GET /best-rate/:asset':      { price: 0.0025, description: 'Best supply/borrow rate for asset' },
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
function buildRequirements(req, price, description) {
  // MUST be byte-identical in structure to what /verify and /settle receive
  return {
    scheme: 'exact',
    network: 'xdc',
    maxAmountRequired: toAtomic(price),
    resource: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
    description,
    mimeType: 'application/json',
    payTo: RECEIVER_WALLET,
    asset: USDC_XDC,
    maxTimeoutSeconds: 60,
    extra: { name: 'USDC', version: '2' },
  };
}

async function callFacilitator(step, paymentHeader, paymentRequirements) {
  // Decode the base64 X-PAYMENT header into its JSON payload
  let decoded = null;
  try { decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8')); } catch (_) {}

  // Canonical x402 facilitator body first; alternate encoding as fallback on 400
  const attempts = [];
  if (decoded) attempts.push({ x402Version: 1, paymentPayload: decoded, paymentRequirements });
  attempts.push({ x402Version: 1, paymentHeader, paymentRequirements });

  let lastErr = null;
  for (const body of attempts) {
    try {
      const r = await axios.post(`${FACILITATOR_URL}/${step}`, body, {
        timeout: 12000,
        headers: { 'Content-Type': 'application/json' },
      });
      return r.data;
    } catch (e) {
      lastErr = e;
      // Only try the alternate encoding on a 400 (bad request shape).
      if (!e.response || e.response.status !== 400) break;
    }
  }
  const detail = lastErr?.response?.data || lastErr?.message || 'unknown facilitator error';
  const err = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  err.facilitatorStatus = lastErr?.response?.status;
  throw err;
}

function x402(routeKey, precheck) {
  const { price, description } = ROUTES[routeKey];

  return async (req, res, next) => {
    const payment = req.headers['x-payment'];
    const requirements = buildRequirements(req, price, description);

    if (!payment) {
      return res.status(402).json({ x402Version: 1, accepts: [requirements] });
    }

    // VALIDATE BEFORE CHARGING: if the request can't be served, reject now —
    // no verify, no settle, no funds moved.
    if (precheck) {
      try {
        const problem = await precheck(req);
        if (problem) {
          return res.status(problem.status || 404).json({
            ...problem.body,
            payment: 'not taken — request rejected before settlement',
          });
        }
      } catch (e) {
        return res.status(503).json({ error: 'Validation unavailable, no payment taken', detail: e.message });
      }
    }

    try {
      // VERIFY
      const v = await callFacilitator('verify', payment, requirements);
      const isValid = v?.isValid ?? v?.valid ?? false;
      if (!isValid) {
        return res.status(402).json({
          x402Version: 1,
          error: 'Payment invalid',
          invalidReason: v?.invalidReason || v?.reason || null,
          accepts: [requirements],
        });
      }

      // SETTLE
      const s = await callFacilitator('settle', payment, requirements);
      const settled = s?.success ?? s?.settled ?? Boolean(s?.txHash);
      if (!settled) {
        return res.status(402).json({
          x402Version: 1,
          error: 'Settlement failed',
          detail: s || null,
          accepts: [requirements],
        });
      }

      res.set('X-Payment-Response', Buffer.from(JSON.stringify({
        success: true,
        txHash: s?.txHash || s?.transaction || 'settled',
        networkId: 'xdc',
      })).toString('base64'));

      next();
    } catch (err) {
      console.error(`[x402] ${routeKey} facilitator error (status ${err.facilitatorStatus || '?'}):`, err.message);
      return res.status(402).json({
        x402Version: 1,
        error: 'Payment verification failed',
        detail: err.message,
        facilitatorStatus: err.facilitatorStatus || null,
        accepts: [requirements],
      });
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

let priceCache = { data: null, fetchedAt: 0 };

async function getLivePrices() {
  const now = Date.now();
  if (priceCache.data && now - priceCache.fetchedAt < 5 * 60 * 1000) return priceCache.data;
  try {
    const r = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: { ids: 'xdce-crowd-sale,ethereum,bitcoin,usd-coin,tether', vs_currencies: 'usd' },
      timeout: 8000,
    });
    const d = r.data;
    const prices = {
      XDC:  d['xdce-crowd-sale']?.usd ?? null,
      WXDC: d['xdce-crowd-sale']?.usd ?? null,
      WETH: d['ethereum']?.usd ?? null,
      WBTC: d['bitcoin']?.usd ?? null,
      USDC: d['usd-coin']?.usd ?? 1.0,
      USDT: d['tether']?.usd ?? 1.0,
    };
    if (prices.XDC == null) throw new Error('missing XDC price');
    priceCache = { data: { prices, source: 'coingecko-live' }, fetchedAt: now };
    return priceCache.data;
  } catch (e) {
    console.warn('[prices] live fetch failed:', e.message);
    return priceCache.data || { prices: { XDC: 0.028, WXDC: 0.028, WETH: 3500, WBTC: 68000, USDC: 1.0, USDT: 1.0 }, source: 'fallback-snapshot' };
  }
}

async function getLendingRates() {
  const now = Date.now();
  if (ratesCache.data && now - ratesCache.fetchedAt < CACHE_TTL) return ratesCache.data;

  // Live Silo Finance V3 (on-chain XDC reads) — prepended to whatever DeFiLlama returns
  let siloProtocol = null;
  try { siloProtocol = await silo.getSiloRates(); } catch (e) { console.warn('[silo] rates read failed:', e.message); }

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

    if (siloProtocol) data.protocols.unshift(siloProtocol);
    ratesCache = { data, fetchedAt: now };
    return data;
  } catch (err) {
    console.warn('[rates] live fetch failed, serving fallback:', err.message);
    const fb = { ...FALLBACK_RATES, timestamp: new Date().toISOString() };
    if (siloProtocol) fb.protocols = [siloProtocol, ...fb.protocols];
    return fb;
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

async function simulateBorrow({ collateralAsset, collateralAmount, borrowAsset, protocol }) {
  const ltv = { XDC: 0.65, WXDC: 0.65, WETH: 0.70, WBTC: 0.70, USDC: 0.85 }[collateralAsset] || 0.65;
  const { prices, source } = await getLivePrices();
  const colPrice = prices[collateralAsset];
  if (colPrice == null) {
    return { error: `Unsupported collateral asset: ${collateralAsset}`, supported: Object.keys(prices) };
  }
  const colUSD = colPrice * collateralAmount;
  const maxUSD = colUSD * ltv;
  return {
    timestamp: new Date().toISOString(), simulation: true, priceSource: source,
    inputs: { collateralAsset, collateralAmount, borrowAsset, protocol },
    marketPrices: { [collateralAsset]: colPrice, [borrowAsset]: prices[borrowAsset] ?? null },
    result: {
      collateralValueUSD: +colUSD.toFixed(2),
      maxBorrowUSD: +maxUSD.toFixed(2),
      maxBorrowAmount: +(maxUSD / (prices[borrowAsset] || 1)).toFixed(6),
      ltvRatio: ltv,
      recommendedBorrowUSD: +(maxUSD * 0.75).toFixed(2),
      healthFactorAtMax: 1.18,
      healthFactorAtRecommended: 1.55,
      liquidationPrice: +(colPrice * 0.75).toFixed(6),
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

// ── PRE-PAYMENT VALIDATION HELPERS ───────────────────────────────────────────
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function findProtocol(name) {
  const data = await getLendingRates();
  const n = norm(name);
  const found = data.protocols.find(p => norm(p.protocol).includes(n) || n.includes(norm(p.protocol)));
  return { data, found };
}

const precheckProtocol = async (req) => {
  const { found, data } = await findProtocol(req.params.protocol);
  if (!found) return { status: 404, body: {
    error: `Protocol not found: ${req.params.protocol}`,
    available: data.protocols.map(p => p.protocol),
    dataSource: data.dataSource,
  }};
  req._protocol = { data, found };
  return null;
};

const precheckWallet = (req) =>
  (!req.params.wallet || !/^(0x|xdc)[0-9a-fA-F]{40}$/.test(req.params.wallet))
    ? { status: 400, body: { error: 'Invalid wallet address — expected 0x… or xdc… (40 hex chars)' } }
    : null;

const precheckBorrowBody = (req) => {
  const { collateralAsset, collateralAmount, borrowAsset } = req.body || {};
  if (!collateralAsset || !collateralAmount || !borrowAsset)
    return { status: 400, body: { error: 'Missing required fields', required: { collateralAsset: 'XDC|WXDC|WETH|WBTC|USDC', collateralAmount: 'number', borrowAsset: 'USDC|USDT' } } };
  return null;
};

const precheckLiqBody = (req) => {
  const { wallet, priceDropPercent } = req.body || {};
  if (!wallet || priceDropPercent === undefined)
    return { status: 400, body: { error: 'Missing required fields', required: { wallet: 'string', priceDropPercent: 'number 0-100' } } };
  return null;
};

const precheckAsset = async (req) => {
  const data = await getLendingRates();
  const n = norm(req.params.asset);
  const ok = data.protocols.some(p => p.assets.some(a => norm(a.asset).includes(n)));
  if (!ok) return { status: 404, body: { error: `No rates for asset: ${req.params.asset}`, hint: 'Try USDC, USDT, XDC, WXDC', dataSource: data.dataSource } };
  return null;
};

// ── FREE ROUTES ───────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.redirect('/info'));

app.get('/health', (_, res) => res.json({
  status: 'ok', service: 'XDC Lending API', version: '1.5.1',
  build: 'usd-positions',
  network: 'xdc', timestamp: new Date().toISOString(),
}));

app.get('/info', (_, res) => res.json({
  id: 'xdc-lending-api',
  name: 'XDC Lending API',
  description: 'Pay-per-call lending data for AI agents on XDC Network. Rates, positions, collateral, simulations, liquidations.',
  version: '1.5.1',
  build: 'usd-positions',
  network: 'xdc',
  payment: {
    protocol: 'x402', asset: USDC_XDC, network: 'xdc', decimals: 6,
    facilitator: FACILITATOR_URL, payTo: RECEIVER_WALLET,
  },
  services: Object.entries(ROUTES).map(([key, val]) => {
    const [method, path] = [key.split(' ')[0], key.split(' ').slice(1).join(' ')];
    return { url: `https://xdc-lending-api.onrender.com${path}`, method, priceUSDC: String(val.price), description: val.description };
  }),
  tags: ['lending', 'defi', 'xdc', 'rates', 'positions', 'liquidations'],
}));

app.get('/silo/position-full', async (req, res) => {
  const wallet = req.query.wallet;
  if (!wallet || !/^(0x|xdc)[0-9a-fA-F]{40}$/.test(wallet))
    return res.status(400).json({ error: 'Provide ?wallet=0x…' });
  try { res.json(await silo.getWalletPosition(wallet)); }
  catch (e) { res.status(500).json({ error: 'position read failed', detail: e.message }); }
});

app.get('/silo/position-test', async (req, res) => {
  const wallet = req.query.wallet;
  if (!wallet || !/^(0x|xdc)[0-9a-fA-F]{40}$/.test(wallet))
    return res.status(400).json({ error: 'Provide ?wallet=0x… (a wallet with a Silo position)' });
  try { res.json(await silo.diagnosePosition(wallet)); }
  catch (e) { res.status(500).json({ error: 'position diagnostic failed', detail: e.message }); }
});

app.get('/silo/test', async (_, res) => {
  try {
    const diag = await silo.diagnose();
    res.json(diag);
  } catch (e) {
    res.status(500).json({ error: 'diagnostic failed', detail: e.message });
  }
});

// ── PAID ROUTES ───────────────────────────────────────────────────────────────
app.get('/rates', x402('GET /rates'), async (_, res) => res.json(await getLendingRates()));

app.get('/rates/:protocol', x402('GET /rates/:protocol', precheckProtocol), async (req, res) => {
  const { data, found } = req._protocol || await findProtocol(req.params.protocol);
  if (!found) return res.status(404).json({ error: `Protocol not found: ${req.params.protocol}`, available: data.protocols.map(p => p.protocol) });
  res.json({ timestamp: data.timestamp, network: data.network, dataSource: data.dataSource, protocol: found });
});

app.get('/collateral', x402('GET /collateral'), async (_, res) => {
  const base = getCollateral();
  try {
    const siloCol = await silo.getSiloCollateral();
    if (siloCol && siloCol.length) {
      base.siloMarkets = siloCol;
      base.dataSource = 'silo-v3-onchain + reference';
    }
  } catch (e) { /* fall back to reference table only */ }
  res.json(base);
});

app.get('/position/:wallet', x402('GET /position/:wallet', precheckWallet), async (req, res) => {
  try {
    const pos = await silo.getWalletPosition(req.params.wallet);
    res.json(pos);
  } catch (e) {
    // fall back to demo shape only if the on-chain read fails outright
    console.warn('[position] on-chain read failed:', e.message);
    res.json({ ...getPosition(req.params.wallet), dataSource: 'demo-fallback', warning: 'on-chain read failed' });
  }
});

app.post('/simulate/borrow', x402('POST /simulate/borrow', precheckBorrowBody), async (req, res) => {
  const { collateralAsset, collateralAmount, borrowAsset } = req.body;
  if (!collateralAsset || !collateralAmount || !borrowAsset)
    return res.status(400).json({ error: 'Missing required fields', required: { collateralAsset: 'XDC|WETH|WBTC|USDC', collateralAmount: 'number', borrowAsset: 'USDC|USDT' } });
  res.json(await simulateBorrow({ ...req.body, collateralAmount: Number(collateralAmount) }));
});

app.post('/simulate/liquidation', x402('POST /simulate/liquidation', precheckLiqBody), (req, res) => {
  const { wallet, priceDropPercent } = req.body;
  if (!wallet || priceDropPercent === undefined)
    return res.status(400).json({ error: 'Missing required fields', required: { wallet: 'string', priceDropPercent: 'number 0-100' } });
  res.json(simulateLiquidation({ wallet, priceDropPercent: Number(priceDropPercent) }));
});

app.get('/liquidations/recent', x402('GET /liquidations/recent'), (_, res) => res.json(getRecentLiquidations()));

app.get('/best-rate/:asset', x402('GET /best-rate/:asset', precheckAsset), async (req, res) => res.json(await getBestRate(req.params.asset)));

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`XDC Lending API v1.5.1 → port ${PORT} | payTo ${RECEIVER_WALLET}`);
});

module.exports = app;
