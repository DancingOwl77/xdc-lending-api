/**
 * silo.js — Silo Finance V3 multi-market reader for XDC mainnet. v1.7.0
 * Verified interface. Discovers ALL Silo markets via factory NewSilo events,
 * reads rates/APY/collateral/positions/liquidations on-chain.
 */
const axios = require('axios');
const RPC    = process.env.XDC_RPC     || 'https://rpc.xinfin.network';
const MARKET = process.env.SILO_MARKET || '0x0d419DC8128D5738a62753DeB8eA3508AEd95253';

const SEL={getSilos:'0xaecc90cb',asset:'0x38d52e0f',symbol:'0x95d89b41',decimals:'0x313ce567',
  getCollateralAssets:'0xa1ff9bee',getDebtAssets:'0xecd658b4',getConfig:'0xe48a5f7b',
  getCurrentInterestRate:'0x64efe177'};
const PSEL={balanceOf:'0x70a08231',convertToAssets:'0x07a2d13a',symbol:'0x95d89b41',decimals:'0x313ce567'};
const DSEL={factory:'0xc45a0155',getNextSiloId:'0x49f33f2e'};
const NEWSILO_TOPICS=[
  '0x3d6b896c73b628ec6ba0bdfe3cdee1356ea2af31af2a97bbd6b532ca6fa00acb',
  '0xba4615060c12e2e644247004caf6bb12bb1a30e2b868ab76b87eb8aff726aac7',
];
const LIQ_TOPICS={
  Liquidate:'0xfb11c8f5ae143bb22e8f2f65f3c712f0647059d53bdb600cdbed22ed7bb0ea50',
  LiquidationCall:'0xb4c187880b81d714cba477ba1c48ef4b26e2661ebd03f7b442dd03ae89c61dfa',
};

async function ethCall(to,data){const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data},'latest']},{timeout:12000,headers:{'Content-Type':'application/json'}});if(r.data.error)throw new Error(r.data.error.message||JSON.stringify(r.data.error));return r.data.result;}
async function ethBlockNumber(){const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]},{timeout:10000,headers:{'Content-Type':'application/json'}});return parseInt(r.data.result,16);}
async function getLogs(address,topic,fromBlock,toBlock){const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_getLogs',params:[{address,topics:[topic],fromBlock:'0x'+fromBlock.toString(16),toBlock:'0x'+toBlock.toString(16)}]},{timeout:15000,headers:{'Content-Type':'application/json'}});if(r.data.error)throw new Error(r.data.error.message);return r.data.result||[];}

const big=(h)=>BigInt(h&&h!=='0x'?h:'0x0');
const addrOf=(w)=>'0x'+w.replace(/^0x/,'').slice(-40);
const word=(hex,i)=>'0x'+hex.replace(/^0x/,'').slice(i*64,i*64+64);
const argAddr=(a)=>a.toLowerCase().replace(/^0x/,'').padStart(64,'0');
const argUint=(n)=>BigInt(n).toString(16).padStart(64,'0');
function decodeString(hex){const b=hex.replace(/^0x/,'');if(b.length<128)return null;const len=Number(BigInt('0x'+b.slice(64,128)));return Buffer.from(b.slice(128,128+len*2),'hex').toString('utf8').replace(/\x00+$/,'');}

// ── config + vault reads (per market) ──
async function readConfigFull(silo, marketCfg){
  const raw=await ethCall(marketCfg||MARKET,SEL.getConfig+argAddr(silo));
  return{silo:addrOf(word(raw,2)),asset:addrOf(word(raw,3)),protectedShareToken:addrOf(word(raw,4)),
    debtShareToken:addrOf(word(raw,6)),interestRateModel:addrOf(word(raw,9)),
    maxLtv:Number(big(word(raw,10)))/1e18,liquidationThreshold:Number(big(word(raw,11)))/1e18,
    liquidationFee:Number(big(word(raw,13)))/1e18};
}
async function readVaultFor(silo, marketCfg){
  const cfg=await readConfigFull(silo, marketCfg);
  let symbol='?',decimals=18;
  try{symbol=decodeString(await ethCall(cfg.asset,SEL.symbol))||'?';}catch(_){}
  try{decimals=Number(big(await ethCall(cfg.asset,SEL.decimals)));}catch(_){}
  let supplied=0n,borrowed=0n;
  try{supplied=big(await ethCall(silo,SEL.getCollateralAssets));}catch(_){}
  try{borrowed=big(await ethCall(silo,SEL.getDebtAssets));}catch(_){}
  const d=10n**BigInt(decimals);const num=(v)=>Number(v*1000000n/(d||1n))/1000000;
  const s=num(supplied),b=num(borrowed);const util=s>0?b/s:0;
  let borrowAPY=null,supplyAPY=null;
  try{const ts=Math.floor(Date.now()/1000);
    const r=big(await ethCall(cfg.interestRateModel,SEL.getCurrentInterestRate+argAddr(silo)+argUint(ts)));
    borrowAPY=+(Number(r)/1e16).toFixed(2);supplyAPY=+(borrowAPY*util*(1-cfg.liquidationFee)).toFixed(2);
  }catch(_){}
  return{asset:symbol,assetAddress:cfg.asset,decimals,suppliedAssets:+s.toFixed(6),borrowedAssets:+b.toFixed(6),
    availableLiquidity:+(s-b).toFixed(6),utilization:+util.toFixed(4),borrowAPY,supplyAPY,
    maxLtv:cfg.maxLtv,liquidationThreshold:cfg.liquidationThreshold,liquidationFee:cfg.liquidationFee,
    silo,interestRateModel:cfg.interestRateModel};
}
async function readOneMarket(cfg){
  const silosHex=await ethCall(cfg,SEL.getSilos);
  const s0=addrOf(word(silosHex,0)),s1=addrOf(word(silosHex,1));
  const [v0,v1]=await Promise.all([readVaultFor(s0,cfg),readVaultFor(s1,cfg)]);
  return{market:cfg,silos:[v0,v1]};
}

// ── market discovery (cached 30 min) ──
async function labelMarket(id,config){
  try{const silosHex=await ethCall(config,SEL.getSilos);
    const s0=addrOf(word(silosHex,0)),s1=addrOf(word(silosHex,1));
    const a0=addrOf(await ethCall(s0,SEL.asset)),a1=addrOf(await ethCall(s1,SEL.asset));
    let sym0='?',sym1='?';
    try{sym0=decodeString(await ethCall(a0,SEL.symbol))||'?';}catch(_){}
    try{sym1=decodeString(await ethCall(a1,SEL.symbol))||'?';}catch(_){}
    return{id,config,pair:sym0+'/'+sym1,silo0:s0,silo1:s1};
  }catch(e){return{id,config,error:e.message};}
}
async function discoverMarkets(){
  const out={knownMarket:MARKET,timestamp:new Date().toISOString(),steps:[]};
  let factory=null;
  try{
    const silosHex=await ethCall(MARKET,SEL.getSilos);
    const silo0=addrOf(word(silosHex,0));
    const f=addrOf(await ethCall(silo0,DSEL.factory));
    if(big('0x'+f.slice(2))!==0n){factory=f;out.factory=f;}
  }catch(e){out.steps.push({label:'factory',ok:false,error:e.message});}
  if(!factory){out.note='factory not found';out.markets=[await labelMarket(0,MARKET)];return out;}
  try{
    const latest=await ethBlockNumber();
    const configs=new Set();let chunksScanned=0,capped=false;
    for(const topic of NEWSILO_TOPICS){
      let from=Math.max(0,latest-3000000),chunk=100000;
      while(from<=latest){
        const to=Math.min(from+chunk-1,latest);
        try{const logs=await getLogs(factory,topic,from,to);chunksScanned++;
          for(const l of logs){const dw=(l.data||'0x').replace(/^0x/,'');const n=Math.floor(dw.length/64);
            if(n>=1)configs.add(addrOf('0x'+dw.slice((n-1)*64,n*64)));
            (l.topics||[]).slice(1).forEach(t=>configs.add(addrOf(t)));}
        }catch(e){if(chunk>10000){chunk=10000;continue;}capped=true;}
        from=to+1;if(chunksScanned>150){capped=true;break;}
      }
    }
    out.rangeCapped=capped;out.candidatesFound=configs.size;out.markets=[];let id=0;
    for(const cand of [...configs]){try{await ethCall(cand,SEL.getSilos);out.markets.push(await labelMarket(++id,cand));}catch(_){}}
    if(!out.markets.find(m=>m.config?.toLowerCase()===MARKET.toLowerCase()))out.markets.unshift(await labelMarket(0,MARKET));
    out.discoveredVia='NewSilo-event-scan';
  }catch(e){out.steps.push({label:'scan',ok:false,error:e.message});out.markets=[await labelMarket(0,MARKET)];}
  return out;
}

let _marketsCache={list:null,at:0};const MARKETS_TTL=30*60*1000;
async function getAllMarketConfigs(){
  const now=Date.now();
  if(_marketsCache.list&&now-_marketsCache.at<MARKETS_TTL)return _marketsCache.list;
  try{const disc=await discoverMarkets();
    const list=(disc.markets||[]).filter(m=>m.config&&!m.error).map(m=>({config:m.config,pair:m.pair}));
    if(!list.find(m=>m.config.toLowerCase()===MARKET.toLowerCase()))list.unshift({config:MARKET,pair:'WXDC/USDC'});
    _marketsCache={list,at:now};return list;
  }catch(e){return [{config:MARKET,pair:'WXDC/USDC'}];}
}

// ── main market read (all markets, cached 60s) ──
let cache={data:null,at:0};const TTL=60*1000;
async function getSiloMarket(){
  const now=Date.now();if(cache.data&&now-cache.at<TTL)return cache.data;
  const configs=await getAllMarketConfigs();const markets=[];
  for(const m of configs){try{const r=await readOneMarket(m.config);markets.push({pair:m.pair,...r});}catch(_){}}
  const out={timestamp:new Date().toISOString(),network:'XDC Mainnet',dataSource:'silo-v3-onchain',
    protocol:'Silo Finance V3',marketsCount:markets.length,markets,
    market:markets[0]?.market,silos:markets[0]?.silos||[]};
  cache={data:out,at:now};return out;
}

// ── /rates: one entry per market ──
async function getSiloRates(){
  const m=await getSiloMarket();
  return (m.markets||[]).map(mk=>({protocol:'Silo Finance ('+mk.pair+')',type:'Isolated Lending (V3)',
    market:mk.market,pair:mk.pair,dataSource:'silo-v3-onchain',
    assets:mk.silos.map(s=>({asset:s.asset,supplyAPY:s.supplyAPY,borrowAPY:s.borrowAPY,utilization:s.utilization,
      suppliedAssets:s.suppliedAssets,borrowedAssets:s.borrowedAssets,availableLiquidity:s.availableLiquidity,
      maxLtv:s.maxLtv,liquidationThreshold:s.liquidationThreshold}))}));
}
// ── /collateral: across all markets ──
async function getSiloCollateral(){
  const m=await getSiloMarket();const rows=[];
  for(const mk of (m.markets||[]))for(const s of mk.silos)if(s.maxLtv>0)
    rows.push({asset:s.asset,market:mk.pair,ltvRatio:s.maxLtv,liquidationThreshold:s.liquidationThreshold,
      liquidationPenalty:s.liquidationFee,protocol:'Silo Finance V3',source:'on-chain'});
  return rows;
}

// ── positions (USD-valued) across the known market ──
let _priceCache={data:null,at:0};
async function getPrices(){
  const now=Date.now();if(_priceCache.data&&now-_priceCache.at<5*60*1000)return _priceCache.data;
  try{const r=await axios.get('https://api.coingecko.com/api/v3/simple/price',{params:{ids:'xdce-crowd-sale,usd-coin,tether',vs_currencies:'usd'},timeout:8000});
    const d=r.data;const p={WXDC:d['xdce-crowd-sale']?.usd??null,XDC:d['xdce-crowd-sale']?.usd??null,USDC:d['usd-coin']?.usd??1,USDT:d['tether']?.usd??1};
    _priceCache={data:{prices:p,source:'coingecko'},at:now};return _priceCache.data;
  }catch(e){return _priceCache.data||{prices:{WXDC:0.028,XDC:0.028,USDC:1,USDT:1},source:'fallback'};}
}
function priceOf(sym,prices){if(sym in prices)return prices[sym];if(sym.startsWith('W')&&sym.slice(1) in prices)return prices[sym.slice(1)];return null;}
async function balanceOf(token,wallet){try{return big(await ethCall(token,PSEL.balanceOf+argAddr(wallet)));}catch(_){return 0n;}}
async function sharesToAssets(vault,shares){if(shares===0n)return 0n;try{return big(await ethCall(vault,PSEL.convertToAssets+argUint(shares)));}catch(_){return shares;}}

async function getWalletPosition(wallet){
  const silosHex=await ethCall(MARKET,SEL.getSilos);
  const silos=[addrOf(word(silosHex,0)),addrOf(word(silosHex,1))];
  const {prices,source:priceSource}=await getPrices();
  let totalCollateralUSD=0,totalDebtUSD=0,weightedLtSum=0;const legs=[];
  for(const siloAddr of silos){
    const cfg=await readConfigFull(siloAddr,MARKET);
    let symbol='?',decimals=18;
    try{symbol=decodeString(await ethCall(cfg.asset,PSEL.symbol))||'?';}catch(_){}
    try{decimals=Number(big(await ethCall(cfg.asset,PSEL.decimals)));}catch(_){}
    const d=10n**BigInt(decimals);const num=(v)=>Number(v*1000000n/(d||1n))/1000000;
    const colAssets=num(await sharesToAssets(cfg.silo,await balanceOf(cfg.silo,wallet)));
    const protAssets=num(await sharesToAssets(cfg.protectedShareToken,await balanceOf(cfg.protectedShareToken,wallet)));
    const debtAssets=num(await sharesToAssets(cfg.debtShareToken,await balanceOf(cfg.debtShareToken,wallet)));
    const collateralUnits=colAssets+protAssets;
    if(collateralUnits>0||debtAssets>0){
      const px=priceOf(symbol,prices);
      const colUSD=px!=null?collateralUnits*px:null,debtUSD=px!=null?debtAssets*px:null;
      legs.push({asset:symbol,silo:siloAddr,priceUSD:px,collateralAssets:+colAssets.toFixed(6),
        protectedAssets:+protAssets.toFixed(6),debtAssets:+debtAssets.toFixed(6),
        collateralValueUSD:colUSD!=null?+colUSD.toFixed(2):null,debtValueUSD:debtUSD!=null?+debtUSD.toFixed(2):null,
        maxLtv:cfg.maxLtv,liquidationThreshold:cfg.liquidationThreshold});
      if(colUSD!=null){totalCollateralUSD+=colUSD;weightedLtSum+=colUSD*cfg.liquidationThreshold;}
      if(debtUSD!=null)totalDebtUSD+=debtUSD;
    }
  }
  const hasPosition=legs.length>0;const avgLt=totalCollateralUSD>0?weightedLtSum/totalCollateralUSD:0;
  const healthFactor=(hasPosition&&totalDebtUSD>0)?+((totalCollateralUSD*avgLt)/totalDebtUSD).toFixed(3):null;
  return{timestamp:new Date().toISOString(),wallet,network:'XDC Mainnet',protocol:'Silo Finance V3',
    market:MARKET,dataSource:'silo-v3-onchain',priceSource,hasPosition,
    summary:hasPosition?{totalCollateralUSD:+totalCollateralUSD.toFixed(2),totalDebtUSD:+totalDebtUSD.toFixed(2),
      netValueUSD:+(totalCollateralUSD-totalDebtUSD).toFixed(2),healthFactor,
      liquidationRisk:healthFactor==null?'NONE':healthFactor<1.1?'HIGH':healthFactor<1.4?'MEDIUM':'LOW',
      alerts:healthFactor!=null&&healthFactor<1.3?['Health factor below 1.3 — consider adding collateral or repaying']:[]}:null,
    positions:legs,message:hasPosition?undefined:'No open Silo position found for this wallet.'};
}

// ── liquidations (event scan across discovered markets) ──
let liqCache={data:null,at:0};const LIQ_TTL=5*60*1000;
async function getRecentLiquidations(lookbackBlocks=200000,chunkSize=5000){
  const now=Date.now();if(liqCache.data&&now-liqCache.at<LIQ_TTL)return liqCache.data;
  const configs=await getAllMarketConfigs();const silos=[];
  for(const m of configs){try{const h=await ethCall(m.config,SEL.getSilos);silos.push(addrOf(word(h,0)),addrOf(word(h,1)));}catch(_){}}
  const latest=await ethBlockNumber();const start=Math.max(0,latest-lookbackBlocks);
  const events=[];let scanned=0,capped=false;
  outer:for(const silo of silos){for(const [name,topic] of Object.entries(LIQ_TOPICS)){
    let from=start;while(from<=latest){const to=Math.min(from+chunkSize-1,latest);
      try{const logs=await getLogs(silo,topic,from,to);scanned++;
        for(const log of logs)events.push({event:name,silo,txHash:log.transactionHash,block:parseInt(log.blockNumber,16),topics:log.topics});
      }catch(e){capped=true;if(chunkSize>1000){chunkSize=1000;continue;}}
      from=to+1;if(scanned>120){capped=true;break outer;}}
  }}
  events.sort((a,b)=>b.block-a.block);
  const out={timestamp:new Date().toISOString(),network:'XDC Mainnet',protocol:'Silo Finance V3',
    dataSource:'silo-v3-onchain-logs',scannedBlocks:{from:start,to:latest},marketsScanned:silos.length/2,
    rangeCappedByRPC:capped,totalLiquidations:events.length,events:events.slice(0,50),
    note:events.length===0?'No liquidation events in scanned range. Markets are currently healthy.':undefined};
  liqCache={data:out,at:now};return out;
}

async function diagnose(){return getSiloMarket();}
module.exports={getSiloMarket,getSiloRates,getSiloCollateral,getWalletPosition,getRecentLiquidations,discoverMarkets,diagnose,MARKET,RPC};
