/**
 * LendWatch XDC — request stats + wallet balance layer
 * In-memory (resets on redeploy). Attach with attachStats(app, config).
 */
const axios = require('axios');

const stats = {
  startedAt: new Date().toISOString(),
  totalCalls: 0,
  paidCalls: 0,
  revenueUSDC: 0,
  endpoints: {},          // "GET /rates" -> { calls, paid, revenue }
  feed: [],               // last 50 requests
  responseTimesMs: [],    // last 200
  callers: new Set(),     // masked IPs
};

let balanceCache = { usdc: null, fetchedAt: 0 };

async function getUsdcBalance(wallet, usdcContract) {
  const now = Date.now();
  if (balanceCache.usdc !== null && now - balanceCache.fetchedAt < 60_000) return balanceCache.usdc;
  try {
    const addr = wallet.toLowerCase().replace('0x', '').padStart(64, '0');
    const resp = await axios.post('https://rpc.xinfin.network', {
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: usdcContract, data: '0x70a08231' + addr }, 'latest'],
    }, { timeout: 8000 });
    const raw = BigInt(resp.data?.result || '0x0');
    const usdc = Number(raw) / 1e6;
    balanceCache = { usdc, fetchedAt: now };
    return usdc;
  } catch (e) {
    return balanceCache.usdc; // stale or null
  }
}

function maskIp(ip) {
  if (!ip) return 'unknown';
  const parts = String(ip).split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : String(ip).slice(0, 12) + '…';
}

function attachStats(app, { routes, wallet, usdcContract, priceOf }) {
  // request recorder — mount before routes
  app.use((req, res, next) => {
    if (req.path === '/dashboard' || req.path === '/dashboard-stats' || req.path === '/favicon.ico') return next();
    const t0 = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - t0;
      const key = `${req.method} ${req.route?.path ? (req.baseUrl + req.route.path) : req.path}`;
      const paid = Boolean(res.getHeader('X-Payment-Response'));
      const price = paid ? (priceOf(key) || 0) : 0;

      stats.totalCalls++;
      if (paid) { stats.paidCalls++; stats.revenueUSDC += price; }
      stats.callers.add(maskIp(req.ip));
      stats.responseTimesMs.push(ms);
      if (stats.responseTimesMs.length > 200) stats.responseTimesMs.shift();

      const ep = stats.endpoints[key] = stats.endpoints[key] || { calls: 0, paid: 0, revenue: 0 };
      ep.calls++; if (paid) { ep.paid++; ep.revenue += price; }

      stats.feed.unshift({
        method: req.method, path: req.path, status: res.statusCode,
        paid, priceUSDC: price || null, caller: maskIp(req.ip),
        ts: new Date().toISOString(), ms,
      });
      if (stats.feed.length > 50) stats.feed.pop();
    });
    next();
  });

  // stats endpoint (free)
  app.get('/dashboard-stats', async (_, res) => {
    const usdc = await getUsdcBalance(wallet, usdcContract);
    const avgMs = stats.responseTimesMs.length
      ? Math.round(stats.responseTimesMs.reduce((a, b) => a + b, 0) / stats.responseTimesMs.length)
      : null;
    res.json({
      service: 'LendWatch XDC',
      startedAt: stats.startedAt,
      totals: {
        calls: stats.totalCalls,
        paidCalls: stats.paidCalls,
        revenueUSDC: +stats.revenueUSDC.toFixed(6),
        uniqueCallers: stats.callers.size,
        avgResponseMs: avgMs,
      },
      wallet: { address: wallet, usdcBalance: usdc },
      endpoints: Object.entries(stats.endpoints).map(([key, v]) => ({ endpoint: key, ...v, revenue: +v.revenue.toFixed(6) })),
      routes: routes, // catalogue with prices so dashboard can render all endpoints even before first call
      feed: stats.feed,
      note: 'Stats are in-memory since last deploy/restart.',
    });
  });
}

module.exports = { attachStats };
