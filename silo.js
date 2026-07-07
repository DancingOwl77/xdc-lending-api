
/**
 * silo.js — live Silo V3 reads from XDC mainnet via JSON-RPC eth_call
 * Diagnostic-first: every read is attempted independently and reports ok/err,
 * so /silo/test shows exactly which selectors work against the live contract.
 * No keys, no gas — plain eth_call. Cached 60s once verified.
 */
const axios = require('axios');

const RPC    = process.env.XDC_RPC    || 'https://rpc.xinfin.network';
const MARKET = process.env.SILO_MARKET || '0x0d419DC8128D5738a62753DeB8eA3508AEd95253';

// Known 4-byte selectors (standard ERC-4626 + Silo V3 candidates).
const SEL = {
  decimals:            '0x313ce567', // decimals()
  symbol:              '0x95d89b41', // symbol()
  asset:               '0x38d52e0f', // asset()
  totalAssets:         '0x01e1d114', // totalAssets()
  getSilos:            '0xb0f3f371', // getSilos() -> (address,address)   [candidate]
  getCollateralAssets: '0x8fb36037', // getCollateralAssets()             [candidate]
  getDebtAssets:       '0x7e4a6ce0', // getDebtAssets()                   [candidate]
  getLiquidity:        '0x8e15f473', // getLiquidity()                    [candidate]
};

async function ethCall(to, data) {
  const r = await axios.post(RPC, { jsonrpc:'2.0', id:1, method:'eth_call', params:[{to,data},'latest'] },
    { timeout: 12000, headers: {'Content-Type':'application/json'} });
  if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
  return r.data.result;
}
async function ethGetCode(addr) {
  const r = await axios.post(RPC, { jsonrpc:'2.0', id:1, method:'eth_getCode', params:[addr,'latest'] },
    { timeout: 12000, headers: {'Content-Type':'application/json'} });
  return r.data.result || '0x';
}

const big = (h) => BigInt(h && h !== '0x' ? h : '0x0');
const addrOf = (word) => '0x' + word.replace(/^0x/,'').slice(-40);
const word = (hex, i) => '0x' + hex.replace(/^0x/,'').slice(i*64, i*64+64);

function decodeString(hex) {
  const b = hex.replace(/^0x/,'');
  if (b.length < 128) return null;
  const len = Number(BigInt('0x'+b.slice(64,128)));
  return Buffer.from(b.slice(128, 128+len*2), 'hex').toString('utf8').replace(/\x00+$/,'');
}

async function tryCall(label, to, data, decode) {
  try {
    const raw = await ethCall(to, data);
    return { label, ok: true, raw, value: decode ? decode(raw) : raw };
  } catch (e) {
    return { label, ok: false, error: e.message };
  }
}

// Full diagnostic sweep — used by /silo/test
async function diagnose() {
  const out = { market: MARKET, rpc: RPC, timestamp: new Date().toISOString(), steps: [] };

  // 0. Does the market address have code?
  try {
    const code = await ethGetCode(MARKET);
    out.steps.push({ label: 'market.getCode', ok: code.length > 2, codeLen: code.length });
    if (code.length <= 2) { out.fatal = 'Market address has no contract code on this RPC'; return out; }
  } catch (e) {
    out.fatal = 'RPC unreachable: ' + e.message; return out;
  }

  // 1. getSilos() on the market/config
  const silosRes = await tryCall('market.getSilos()', MARKET, SEL.getSilos,
    (raw) => ({ silo0: addrOf(word(raw,0)), silo1: addrOf(word(raw,1)) }));
  out.steps.push(silosRes);

  const silos = silosRes.ok ? [silosRes.value.silo0, silosRes.value.silo1] : [];

  // If getSilos worked, probe each vault
  out.silos = [];
  for (const silo of silos) {
    const vault = { address: silo, reads: [] };
    const assetRes = await tryCall('asset()', silo, SEL.asset, addrOf);
    vault.reads.push(assetRes);

    if (assetRes.ok) {
      const token = assetRes.value;
      vault.reads.push(await tryCall('token.symbol()',   token, SEL.symbol,   decodeString));
      vault.reads.push(await tryCall('token.decimals()', token, SEL.decimals, (r)=>Number(big(r))));
    }
    vault.reads.push(await tryCall('totalAssets()',         silo, SEL.totalAssets,        (r)=>big(r).toString()));
    vault.reads.push(await tryCall('getCollateralAssets()', silo, SEL.getCollateralAssets,(r)=>big(r).toString()));
    vault.reads.push(await tryCall('getDebtAssets()',       silo, SEL.getDebtAssets,      (r)=>big(r).toString()));
    vault.reads.push(await tryCall('getLiquidity()',        silo, SEL.getLiquidity,       (r)=>big(r).toString()));
    out.silos.push(vault);
  }

  out.summary = {
    getSilosWorks: silosRes.ok,
    vaultsProbed: out.silos.length,
    readableAssets: out.silos.filter(v => v.reads.find(r => r.label==='asset()' && r.ok)).length,
  };
  return out;
}

module.exports = { diagnose, MARKET, RPC };
