/**
 * fathom.js — Fathom Lending v3 (Aave v3 fork) reader for XDC mainnet.
 * PoolDataProvider returns per-reserve rates, liquidity, config.
 * Active markets: WXDC, USDC. (FXD/xUSDT/CGO/FTHM deprecated — skipped by default.)
 */
const axios = require('axios');
const RPC = process.env.XDC_RPC || 'https://rpc.xinfin.network';

const DATA_PROVIDER = '0x7fa488a5C88E9E35B0B86127Ec76B0c1F0933191'; // PoolDataProvider (Aave v3)

const SEL={getReserveData:'0x35ea6a75',getReserveConfigurationData:'0x3e150141',
  symbol:'0x95d89b41',decimals:'0x313ce567'};

// Active markets only (deprecated ones excluded for honesty)
const TOKENS=[
  {symbol:'WXDC',address:'0x951857744785E80e2De051c32EE7b25f9c458C42'},
  {symbol:'USDC',address:'0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1'},
];

async function ethCall(to,data){const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data},'latest']},{timeout:12000,headers:{'Content-Type':'application/json'}});if(r.data.error)throw new Error(r.data.error.message||JSON.stringify(r.data.error));return r.data.result;}
const big=(h)=>BigInt(h&&h!=='0x'?h:'0x0');
const wordAt=(hex,i)=>'0x'+hex.replace(/^0x/,'').slice(i*64,i*64+64);
const argAddr=(a)=>a.toLowerCase().replace(/^0x/,'').padStart(64,'0');

const RAY=1e27;
const rayToPct=(v)=>+(Number(v)/RAY*100).toFixed(2);

// Aave v3 getReserveData returns:
// 0 unbacked, 1 accruedToTreasuryScaled, 2 totalAToken, 3 totalStableDebt, 4 totalVariableDebt,
// 5 liquidityRate, 6 variableBorrowRate, 7 stableBorrowRate, 8 averageStableBorrowRate,
// 9 liquidityIndex, 10 variableBorrowIndex, 11 lastUpdateTimestamp
async function readReserve(token){
  const raw=await ethCall(DATA_PROVIDER,SEL.getReserveData+argAddr(token.address));
  const totalAToken     = big(wordAt(raw,2));
  const totalStableDebt = big(wordAt(raw,3));
  const totalVariableDebt=big(wordAt(raw,4));
  const liquidityRate   = big(wordAt(raw,5));
  const variableBorrowRate=big(wordAt(raw,6));
  let ltv=null,liqThreshold=null,liqBonus=null;
  try{
    const c=await ethCall(DATA_PROVIDER,SEL.getReserveConfigurationData+argAddr(token.address));
    ltv=Number(big(wordAt(c,1)))/10000;
    liqThreshold=Number(big(wordAt(c,2)))/10000;
    liqBonus=Number(big(wordAt(c,3)))/10000;
  }catch(_){}
  let decimals=18;
  try{decimals=Number(big(await ethCall(token.address,SEL.decimals)));}catch(_){}
  const d=10n**BigInt(decimals);const num=(v)=>Number(v*1000000n/(d||1n))/1000000;
  const supplied=num(totalAToken);
  const borrowed=num(totalVariableDebt)+num(totalStableDebt);
  return{asset:token.symbol,supplyAPY:rayToPct(liquidityRate),borrowAPY:rayToPct(variableBorrowRate),
    totalSupplied:+supplied.toFixed(6),totalBorrowed:+borrowed.toFixed(6),
    availableLiquidity:+(supplied-borrowed).toFixed(6),
    utilization:supplied>0?+(borrowed/supplied).toFixed(4):0,
    maxLtv:ltv,liquidationThreshold:liqThreshold,liquidationBonus:liqBonus};
}

let cache={data:null,at:0};const TTL=60*1000;
async function getFathomMarket(){
  const now=Date.now();if(cache.data&&now-cache.at<TTL)return cache.data;
  const reserves=[];
  for(const t of TOKENS){try{reserves.push(await readReserve(t));}catch(e){reserves.push({asset:t.symbol,error:e.message});}}
  const out={timestamp:new Date().toISOString(),network:'XDC Mainnet',dataSource:'fathom-aave-v3-onchain',
    protocol:'Fathom Lending',dataProvider:DATA_PROVIDER,reserves};
  cache={data:out,at:now};return out;
}
async function getFathomRates(){
  const m=await getFathomMarket();
  return{protocol:'Fathom Lending',type:'Pooled Lending (Aave v3)',dataSource:'fathom-aave-v3-onchain',
    assets:(m.reserves||[]).filter(r=>!r.error).map(r=>({asset:r.asset,supplyAPY:r.supplyAPY,borrowAPY:r.borrowAPY,
      utilization:r.utilization,suppliedAssets:r.totalSupplied,borrowedAssets:r.totalBorrowed,
      availableLiquidity:r.availableLiquidity,maxLtv:r.maxLtv,liquidationThreshold:r.liquidationThreshold}))};
}
async function getFathomCollateral(){
  const m=await getFathomMarket();
  return (m.reserves||[]).filter(r=>!r.error&&r.maxLtv>0).map(r=>({asset:r.asset,
    ltvRatio:r.maxLtv,liquidationThreshold:r.liquidationThreshold,
    liquidationPenalty:r.liquidationBonus?+(r.liquidationBonus/10000-1).toFixed(4):null,
    protocol:'Fathom Lending',source:'on-chain'}));
}
async function diagnose(){return getFathomMarket();}
module.exports={getFathomMarket,getFathomRates,getFathomCollateral,diagnose,DATA_PROVIDER};
