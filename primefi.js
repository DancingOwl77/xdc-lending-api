/**
 * primefi.js — PrimeFi (Aave v2 fork) reader for XDC mainnet.
 * ProtocolDataProvider exposes per-reserve rates, liquidity, and config.
 * Markets: USDC, USDT, WXDC, PRFI, psXDC.
 */
const axios = require('axios');
const RPC = process.env.XDC_RPC || 'https://rpc.xinfin.network';

const DATA_PROVIDER = '0x2E6bA568aaebadb4db3E018313ee34baD0328988'; // aaveProtocolDataProvider
const LENDING_POOL  = '0x8a619D8E3BfAb54F7C30Ef39Ce16c53429c739C3';

const SEL = {
  getAllReservesTokens:        '0xb316ff89',
  getReserveData:              '0x35ea6a75', // on data provider
  getReserveConfigurationData: '0x3e150141',
  symbol:'0x95d89b41', decimals:'0x313ce567',
  getUserAccountData:          '0xbf92857c', // on lending pool
};

async function ethCall(to,data){const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data},'latest']},{timeout:12000,headers:{'Content-Type':'application/json'}});if(r.data.error)throw new Error(r.data.error.message||JSON.stringify(r.data.error));return r.data.result;}
const big=(h)=>BigInt(h&&h!=='0x'?h:'0x0');
const addrOf=(w)=>'0x'+w.replace(/^0x/,'').slice(-40);
const wordAt=(hex,i)=>'0x'+hex.replace(/^0x/,'').slice(i*64,i*64+64);
const argAddr=(a)=>a.toLowerCase().replace(/^0x/,'').padStart(64,'0');
function decodeString(hex){const b=hex.replace(/^0x/,'');if(b.length<128)return null;const len=Number(BigInt('0x'+b.slice(64,128)));return Buffer.from(b.slice(128,128+len*2),'hex').toString('utf8').replace(/\x00+$/,'');}

// Aave rays: rates are 1e27-scaled per-second? No — Aave liquidityRate/variableBorrowRate are 1e27 APR.
const RAY = 1e27;
const rayToPct = (v) => +(Number(v)/RAY*100).toFixed(2);

// getAllReservesTokens returns (string symbol, address token)[]
async function getReserves(){
  const raw = await ethCall(DATA_PROVIDER, SEL.getAllReservesTokens);
  const b = raw.replace(/^0x/,'');
  // dynamic array of tuples (string,address) — decode via offsets
  const count = Number(BigInt('0x'+b.slice(64,128)));
  const reserves=[];
  // this ABI decode is complex; use a tolerant parser: find 40-hex addresses that are token-like
  // Instead, rely on known token list from docs as fallback
  return reserves; // parsed below via fallback if empty
}

const KNOWN_TOKENS = [
  { symbol:'USDC', address:'0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1' },
  { symbol:'USDT', address:'0xcdA5b77E2E2268D9E09c874c1b9A4c3F07b37555' },
  { symbol:'WXDC', address:'0x951857744785E80e2De051c32EE7b25f9c458C42' },
  { symbol:'PRFI', address:'0x81B244d0be055EF3BEF1b09B7826Cc2b108B2cBD' },
  { symbol:'psXDC',address:'0x9B8e12b0BAC165B86967E771d98B520Ec3F665A6' },
];

// getReserveData(asset) on ProtocolDataProvider returns:
// (availableLiquidity, totalStableDebt, totalVariableDebt, liquidityRate, variableBorrowRate,
//  stableBorrowRate, averageStableBorrowRate, liquidityIndex, variableBorrowIndex, lastUpdateTimestamp)
async function readReserve(token){
  const raw = await ethCall(DATA_PROVIDER, SEL.getReserveData + argAddr(token.address));
  const availableLiquidity = big(wordAt(raw,0));
  const totalStableDebt    = big(wordAt(raw,1));
  const totalVariableDebt  = big(wordAt(raw,2));
  const liquidityRate      = big(wordAt(raw,3)); // supply APR, ray
  const variableBorrowRate = big(wordAt(raw,4)); // borrow APR, ray
  // config for LTV / liquidation threshold
  let ltv=null, liqThreshold=null, liqBonus=null;
  try{
    const c = await ethCall(DATA_PROVIDER, SEL.getReserveConfigurationData + argAddr(token.address));
    // (decimals, ltv, liquidationThreshold, liquidationBonus, reserveFactor, usageAsCollateralEnabled, borrowingEnabled, stableBorrowRateEnabled, isActive, isFrozen)
    ltv = Number(big(wordAt(c,1)))/10000;
    liqThreshold = Number(big(wordAt(c,2)))/10000;
    liqBonus = Number(big(wordAt(c,3)))/10000;
  }catch(_){}
  let decimals=18;
  try{ decimals=Number(big(await ethCall(token.address,SEL.decimals))); }catch(_){}
  const d=10n**BigInt(decimals); const num=(v)=>Number(v*1000000n/(d||1n))/1000000;
  const supplied = num(availableLiquidity)+num(totalVariableDebt)+num(totalStableDebt);
  const borrowed = num(totalVariableDebt)+num(totalStableDebt);
  return {
    asset: token.symbol,
    supplyAPY: rayToPct(liquidityRate),
    borrowAPY: rayToPct(variableBorrowRate),
    availableLiquidity: +num(availableLiquidity).toFixed(6),
    totalSupplied: +supplied.toFixed(6),
    totalBorrowed: +borrowed.toFixed(6),
    utilization: supplied>0 ? +(borrowed/supplied).toFixed(4) : 0,
    maxLtv: ltv, liquidationThreshold: liqThreshold, liquidationBonus: liqBonus,
  };
}

let cache={data:null,at:0}; const TTL=60*1000;
async function getPrimeFiMarket(){
  const now=Date.now(); if(cache.data&&now-cache.at<TTL)return cache.data;
  const reserves=[];
  for(const t of KNOWN_TOKENS){ try{ reserves.push(await readReserve(t)); }catch(e){ reserves.push({asset:t.symbol,error:e.message}); } }
  const out={timestamp:new Date().toISOString(),network:'XDC Mainnet',dataSource:'primefi-aave-v2-onchain',
    protocol:'PrimeFi',dataProvider:DATA_PROVIDER,reserves};
  cache={data:out,at:now}; return out;
}

// formatted for /rates
async function getPrimeFiRates(){
  const m=await getPrimeFiMarket();
  return {protocol:'PrimeFi', type:'Pooled Lending (Aave v2)', dataSource:'primefi-aave-v2-onchain',
    assets:(m.reserves||[]).filter(r=>!r.error).map(r=>({asset:r.asset,supplyAPY:r.supplyAPY,borrowAPY:r.borrowAPY,
      utilization:r.utilization,suppliedAssets:r.totalSupplied,borrowedAssets:r.totalBorrowed,
      availableLiquidity:r.availableLiquidity,maxLtv:r.maxLtv,liquidationThreshold:r.liquidationThreshold}))};
}
async function getPrimeFiCollateral(){
  const m=await getPrimeFiMarket();
  return (m.reserves||[]).filter(r=>!r.error&&r.maxLtv>0).map(r=>({asset:r.asset,
    ltvRatio:r.maxLtv,liquidationThreshold:r.liquidationThreshold,liquidationPenalty:r.liquidationBonus?+(r.liquidationBonus-1).toFixed(4):null,
    protocol:'PrimeFi',source:'on-chain'}));
}

async function diagnose(){ return getPrimeFiMarket(); }
module.exports={getPrimeFiMarket,getPrimeFiRates,getPrimeFiCollateral,diagnose,DATA_PROVIDER,LENDING_POOL};
