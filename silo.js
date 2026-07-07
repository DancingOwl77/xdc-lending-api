/**
 * silo.js — Silo Finance V3 live reader for XDC mainnet. Fully verified on-chain.
 * Market (SiloConfig): 0x0d419DC8128D5738a62753DeB8eA3508AEd95253
 *   getSilos() -> [siloWXDC 0x9ebc…, siloUSDC 0xd1ed…]
 *   getConfig(silo) struct: word3 asset, word9 IRM, word10 maxLtv(1e18),
 *     word11 liquidationThreshold(1e18), word13 liquidationFee(1e18)
 *   silo.getCollateralAssets()/getDebtAssets() -> supplied/borrowed
 *   IRM.getCurrentInterestRate(silo, ts) -> borrow APR (1e18-scaled)  [VERIFIED]
 */
const axios = require('axios');
const RPC    = process.env.XDC_RPC     || 'https://rpc.xinfin.network';
const MARKET = process.env.SILO_MARKET || '0x0d419DC8128D5738a62753DeB8eA3508AEd95253';

const SEL={getSilos:'0xaecc90cb',asset:'0x38d52e0f',symbol:'0x95d89b41',decimals:'0x313ce567',
  getCollateralAssets:'0xa1ff9bee',getDebtAssets:'0xecd658b4',getConfig:'0xe48a5f7b',
  getCurrentInterestRate:'0x64efe177'};

async function ethCall(to,data){const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data},'latest']},{timeout:12000,headers:{'Content-Type':'application/json'}});if(r.data.error)throw new Error(r.data.error.message||JSON.stringify(r.data.error));return r.data.result;}
const big=(h)=>BigInt(h&&h!=='0x'?h:'0x0');
const addrOf=(w)=>'0x'+w.replace(/^0x/,'').slice(-40);
const word=(hex,i)=>'0x'+hex.replace(/^0x/,'').slice(i*64,i*64+64);
const argAddr=(a)=>a.toLowerCase().replace(/^0x/,'').padStart(64,'0');
const argUint=(n)=>BigInt(n).toString(16).padStart(64,'0');
function decodeString(hex){const b=hex.replace(/^0x/,'');if(b.length<128)return null;const len=Number(BigInt('0x'+b.slice(64,128)));return Buffer.from(b.slice(128,128+len*2),'hex').toString('utf8').replace(/\x00+$/,'');}

async function readConfig(silo){
  const raw=await ethCall(MARKET,SEL.getConfig+argAddr(silo));
  return{asset:addrOf(word(raw,3)),interestRateModel:addrOf(word(raw,9)),
    maxLtv:Number(big(word(raw,10)))/1e18,liquidationThreshold:Number(big(word(raw,11)))/1e18,
    liquidationFee:Number(big(word(raw,13)))/1e18};
}

async function readVault(silo){
  const cfg=await readConfig(silo);
  let symbol='?',decimals=18;
  try{symbol=decodeString(await ethCall(cfg.asset,SEL.symbol))||'?';}catch(_){}
  try{decimals=Number(big(await ethCall(cfg.asset,SEL.decimals)));}catch(_){}
  let supplied=0n,borrowed=0n;
  try{supplied=big(await ethCall(silo,SEL.getCollateralAssets));}catch(_){}
  try{borrowed=big(await ethCall(silo,SEL.getDebtAssets));}catch(_){}
  const d=10n**BigInt(decimals); const num=(v)=>Number(v*1000000n/(d||1n))/1000000;
  const s=num(supplied),b=num(borrowed); const util=s>0?b/s:0;

  // real borrow APR from the IRM (verified: getCurrentInterestRate(silo, ts), 1e18-scaled)
  let borrowAPR=null,supplyAPR=null;
  try{
    const ts=Math.floor(Date.now()/1000);
    const r=big(await ethCall(cfg.interestRateModel,SEL.getCurrentInterestRate+argAddr(silo)+argUint(ts)));
    borrowAPR=+(Number(r)/1e16).toFixed(2);               // 1e18 -> %
    supplyAPR=+(borrowAPR*util*(1-cfg.liquidationFee)).toFixed(2);
  }catch(_){}

  return{asset:symbol,assetAddress:cfg.asset,decimals,
    suppliedAssets:+s.toFixed(6),borrowedAssets:+b.toFixed(6),availableLiquidity:+(s-b).toFixed(6),
    utilization:+util.toFixed(4),borrowAPY:borrowAPR,supplyAPY:supplyAPR,
    maxLtv:cfg.maxLtv,liquidationThreshold:cfg.liquidationThreshold,liquidationFee:cfg.liquidationFee,
    silo,interestRateModel:cfg.interestRateModel};
}

let cache={data:null,at:0}; const TTL=60*1000;
async function getSiloMarket(){
  const now=Date.now(); if(cache.data&&now-cache.at<TTL)return cache.data;
  const silosHex=await ethCall(MARKET,SEL.getSilos);
  const [v0,v1]=await Promise.all([readVault(addrOf(word(silosHex,0))),readVault(addrOf(word(silosHex,1)))]);
  const out={timestamp:new Date().toISOString(),network:'XDC Mainnet',dataSource:'silo-v3-onchain',
    protocol:'Silo Finance V3',market:MARKET,silos:[v0,v1]};
  cache={data:out,at:now}; return out;
}

// formatted for /rates protocol list
async function getSiloRates(){
  const m=await getSiloMarket();
  return{protocol:'Silo Finance',type:'Isolated Lending (V3)',market:m.market,dataSource:'silo-v3-onchain',
    assets:m.silos.map(s=>({asset:s.asset,supplyAPY:s.supplyAPY,borrowAPY:s.borrowAPY,
      utilization:s.utilization,suppliedAssets:s.suppliedAssets,borrowedAssets:s.borrowedAssets,
      availableLiquidity:s.availableLiquidity,maxLtv:s.maxLtv,liquidationThreshold:s.liquidationThreshold}))};
}

// formatted for /collateral
async function getSiloCollateral(){
  const m=await getSiloMarket();
  return m.silos.filter(s=>s.maxLtv>0).map(s=>({asset:s.asset,
    ltvRatio:s.maxLtv,liquidationThreshold:s.liquidationThreshold,liquidationPenalty:s.liquidationFee,
    protocol:'Silo Finance V3',source:'on-chain'}));
}



// ── PRICE JOIN (v1.5.1) ──────────────────────────────────────────────────────
let _priceCache = { data: null, at: 0 };
async function getPrices(){
  const now = Date.now();
  if (_priceCache.data && now - _priceCache.at < 5*60*1000) return _priceCache.data;
  try {
    const r = await axios.get('https://api.coingecko.com/api/v3/simple/price',
      { params: { ids: 'xdce-crowd-sale,usd-coin,tether', vs_currencies: 'usd' }, timeout: 8000 });
    const d = r.data;
    const p = {
      WXDC: d['xdce-crowd-sale']?.usd ?? null,
      XDC:  d['xdce-crowd-sale']?.usd ?? null,
      USDC: d['usd-coin']?.usd ?? 1.0,
      USDT: d['tether']?.usd ?? 1.0,
    };
    _priceCache = { data: { prices: p, source: 'coingecko' }, at: now };
    return _priceCache.data;
  } catch(e){
    return _priceCache.data || { prices: { WXDC:0.028, XDC:0.028, USDC:1.0, USDT:1.0 }, source: 'fallback' };
  }
}
function priceOf(symbol, prices){
  if (symbol in prices) return prices[symbol];
  if (symbol.startsWith('W') && symbol.slice(1) in prices) return prices[symbol.slice(1)];
  return null;
}

// ── POSITION READS (v1.5) — verified ISiloConfig.ConfigData layout ──────────
// word2 silo(=collateral ERC4626 share), word3 asset, word4 protectedShareToken,
// word6 debtShareToken, word9 interestRateModel.
const PSEL = { balanceOf:'0x70a08231', convertToAssets:'0x07a2d13a', symbol:'0x95d89b41', decimals:'0x313ce567' };

async function readConfigFull(silo){
  const raw = await ethCall(MARKET, SEL.getConfig + argAddr(silo));
  return {
    silo:                addrOf(word(raw,2)),
    asset:               addrOf(word(raw,3)),
    protectedShareToken: addrOf(word(raw,4)),
    debtShareToken:      addrOf(word(raw,6)),
    interestRateModel:   addrOf(word(raw,9)),
    maxLtv:              Number(big(word(raw,10)))/1e18,
    liquidationThreshold:Number(big(word(raw,11)))/1e18,
    liquidationFee:      Number(big(word(raw,13)))/1e18,
  };
}

async function balanceOf(token, wallet){
  try { return big(await ethCall(token, PSEL.balanceOf + argAddr(wallet))); } catch(_) { return 0n; }
}
async function sharesToAssets(vault, shares){
  if (shares === 0n) return 0n;
  try { return big(await ethCall(vault, PSEL.convertToAssets + argUint(shares))); } catch(_) { return shares; }
}

// Read a wallet's full position across both silos of the market.
async function getWalletPosition(wallet){
  const silosHex = await ethCall(MARKET, SEL.getSilos);
  const silos = [addrOf(word(silosHex,0)), addrOf(word(silosHex,1))];
  const { prices, source: priceSource } = await getPrices();

  let totalCollateralUSD = 0, totalDebtUSD = 0, weightedLtSum = 0;
  const legs = [];

  for (const siloAddr of silos){
    const cfg = await readConfigFull(siloAddr);
    let symbol='?', decimals=18;
    try{ symbol = decodeString(await ethCall(cfg.asset, PSEL.symbol))||'?'; }catch(_){}
    try{ decimals = Number(big(await ethCall(cfg.asset, PSEL.decimals))); }catch(_){}
    const d = 10n**BigInt(decimals);
    const num = (v)=> Number(v*1000000n/(d||1n))/1000000;

    const colShares = await balanceOf(cfg.silo, wallet);
    const colAssets = num(await sharesToAssets(cfg.silo, colShares));
    const protShares = await balanceOf(cfg.protectedShareToken, wallet);
    const protAssets = num(await sharesToAssets(cfg.protectedShareToken, protShares));
    const debtShares = await balanceOf(cfg.debtShareToken, wallet);
    const debtAssets = num(await sharesToAssets(cfg.debtShareToken, debtShares));

    const collateralUnits = colAssets + protAssets;
    if (collateralUnits > 0 || debtAssets > 0){
      const px = priceOf(symbol, prices);
      const colUSD  = px != null ? collateralUnits * px : null;
      const debtUSD = px != null ? debtAssets * px : null;

      legs.push({
        asset: symbol, silo: siloAddr, priceUSD: px,
        collateralAssets: +colAssets.toFixed(6),
        protectedAssets: +protAssets.toFixed(6),
        debtAssets: +debtAssets.toFixed(6),
        collateralValueUSD: colUSD != null ? +colUSD.toFixed(2) : null,
        debtValueUSD: debtUSD != null ? +debtUSD.toFixed(2) : null,
        maxLtv: cfg.maxLtv, liquidationThreshold: cfg.liquidationThreshold,
      });
      if (colUSD != null){ totalCollateralUSD += colUSD; weightedLtSum += colUSD * cfg.liquidationThreshold; }
      if (debtUSD != null){ totalDebtUSD += debtUSD; }
    }
  }

  const hasPosition = legs.length > 0;
  const avgLt = totalCollateralUSD > 0 ? weightedLtSum / totalCollateralUSD : 0;
  // real health factor: (collateral USD * weighted liquidation threshold) / debt USD
  const healthFactor = (hasPosition && totalDebtUSD > 0)
    ? +((totalCollateralUSD * avgLt) / totalDebtUSD).toFixed(3) : null;

  return {
    timestamp: new Date().toISOString(),
    wallet, network: 'XDC Mainnet', protocol: 'Silo Finance V3',
    market: MARKET, dataSource: 'silo-v3-onchain', priceSource,
    hasPosition,
    summary: hasPosition ? {
      totalCollateralUSD: +totalCollateralUSD.toFixed(2),
      totalDebtUSD: +totalDebtUSD.toFixed(2),
      netValueUSD: +(totalCollateralUSD - totalDebtUSD).toFixed(2),
      healthFactor,
      liquidationRisk: healthFactor==null ? 'NONE' : healthFactor<1.1 ? 'HIGH' : healthFactor<1.4 ? 'MEDIUM' : 'LOW',
      alerts: healthFactor!=null && healthFactor<1.3 ? ['Health factor below 1.3 — consider adding collateral or repaying'] : [],
    } : null,
    positions: legs,
    message: hasPosition ? undefined : 'No open Silo position found for this wallet in the XDC/USDC market.',
  };
}

// keep a lightweight position diagnostic for debugging (labels all candidate tokens)
async function diagnosePosition(wallet){
  const silosHex=await ethCall(MARKET,SEL.getSilos);
  const silos=[addrOf(word(silosHex,0)),addrOf(word(silosHex,1))];
  const out={wallet,market:MARKET,silos:[]};
  for(const s of silos){
    const cfg=await readConfigFull(s);
    const read=async(t)=>({token:t,shares:(await balanceOf(t,wallet)).toString()});
    out.silos.push({silo:s,asset:cfg.asset,
      collateralShare:await read(cfg.silo),
      protectedShare:await read(cfg.protectedShareToken),
      debtShare:await read(cfg.debtShareToken)});
  }
  return out;
}

async function diagnose(){ return getSiloMarket(); }
module.exports={getSiloMarket,getSiloRates,getSiloCollateral,getWalletPosition,diagnose,diagnosePosition,MARKET,RPC};
