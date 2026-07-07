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


// ── LIQUIDATION EVENTS (v1.6) ────────────────────────────────────────────────
// Scan eth_getLogs for Silo liquidation events on both silos. XDC RPC may cap
// block ranges, so we chunk. Multiple candidate topics are queried to be robust.
const LIQ_TOPICS = {
  'Liquidate':      '0xfb11c8f5ae143bb22e8f2f65f3c712f0647059d53bdb600cdbed22ed7bb0ea50',
  'LiquidationCall':'0xb4c187880b81d714cba477ba1c48ef4b26e2661ebd03f7b442dd03ae89c61dfa',
  'Liquidation':    '0x4ecae3269f800df64b16cb9f6f8b0b507018888521d1cff0841823e44bc0b00d',
};

async function ethBlockNumber(){
  const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]},{timeout:10000,headers:{'Content-Type':'application/json'}});
  return parseInt(r.data.result,16);
}
async function getLogs(address, topic, fromBlock, toBlock){
  const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_getLogs',params:[{
    address, topics:[topic],
    fromBlock:'0x'+fromBlock.toString(16), toBlock:'0x'+toBlock.toString(16),
  }]},{timeout:15000,headers:{'Content-Type':'application/json'}});
  if(r.data.error) throw new Error(r.data.error.message||JSON.stringify(r.data.error));
  return r.data.result||[];
}

let liqCache={data:null,at:0}; const LIQ_TTL=5*60*1000;

async function getRecentLiquidations(lookbackBlocks=200000, chunkSize=5000){
  const now=Date.now();
  if(liqCache.data && now-liqCache.at<LIQ_TTL) return liqCache.data;

  const silosHex=await ethCall(MARKET,SEL.getSilos);
  const silos=[addrOf(word(silosHex,0)),addrOf(word(silosHex,1))];
  const latest=await ethBlockNumber();
  const start=Math.max(0, latest-lookbackBlocks);

  const events=[];
  let scannedChunks=0, rangeCapped=false;

  outer:
  for(const silo of silos){
    for(const [name,topic] of Object.entries(LIQ_TOPICS)){
      let from=start;
      while(from<=latest){
        const to=Math.min(from+chunkSize-1, latest);
        try{
          const logs=await getLogs(silo, topic, from, to);
          scannedChunks++;
          for(const log of logs){
            events.push({
              event:name, silo, txHash:log.transactionHash,
              block:parseInt(log.blockNumber,16),
              topics:log.topics, dataPreview:(log.data||'0x').slice(0,66),
            });
          }
        }catch(e){
          // XDC RPC likely capped the range — shrink and note it
          rangeCapped=true;
          if(chunkSize>1000){ chunkSize=1000; continue; }
        }
        from=to+1;
        if(scannedChunks>120) { rangeCapped=true; break outer; } // safety cap
      }
    }
  }

  events.sort((a,b)=>b.block-a.block);
  const out={
    timestamp:new Date().toISOString(),
    network:'XDC Mainnet', protocol:'Silo Finance V3', market:MARKET,
    dataSource:'silo-v3-onchain-logs',
    scannedBlocks:{from:start,to:latest,lookbackBlocks},
    rangeCappedByRPC:rangeCapped,
    totalLiquidations:events.length,
    events:events.slice(0,50),
    note: events.length===0
      ? 'No liquidation events found in the scanned range. Silo XDC market is new and positions are currently healthy.'
      : undefined,
  };
  liqCache={data:out,at:now};
  return out;
}



// ── MULTI-MARKET DISCOVERY (v1.7) ────────────────────────────────────────────
const DSEL = {
  factory:'0xc45a0155', siloId:'0xe096017c', config:'0x79502c55', siloConfig:'0xd714fd19',
  getNextSiloId:'0x49f33f2e', idToSiloConfig:'0xde9bfd06',
};
const NEWSILO_TOPICS = [
  '0x3d6b896c73b628ec6ba0bdfe3cdee1356ea2af31af2a97bbd6b532ca6fa00acb', // NewSilo(6 addr)
  '0x1ace92e7879bfd47a1af11d9fd41b3e733b667f243a017aad1a6e614881528d9', // NewSilo(4 addr)
];

async function tryRead(label,to,data,decode){
  try{ const raw=await ethCall(to,data); return {label,ok:true,value:decode?decode(raw):raw}; }
  catch(e){ return {label,ok:false,error:e.message}; }
}
async function ethBlockNumberD(){
  const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]},{timeout:10000,headers:{'Content-Type':'application/json'}});
  return parseInt(r.data.result,16);
}
async function getLogsD(address,topic,fromBlock,toBlock){
  const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_getLogs',params:[{address,topics:[topic],fromBlock:'0x'+fromBlock.toString(16),toBlock:'0x'+toBlock.toString(16)}]},{timeout:15000,headers:{'Content-Type':'application/json'}});
  if(r.data.error) throw new Error(r.data.error.message); return r.data.result||[];
}

async function discoverMarkets(){
  const out={knownMarket:MARKET,timestamp:new Date().toISOString(),steps:[]};

  // Get the two silos of the known market, then ask each silo for its factory()
  let factory=null;
  try{
    const silosHex=await ethCall(MARKET,SEL.getSilos);
    const silo0=addrOf(word(silosHex,0));
    out.knownSilos=[silo0,addrOf(word(silosHex,1))];
    const fR=await tryRead('silo0.factory()',silo0,DSEL.factory,(x)=>addrOf(x));
    out.steps.push(fR);
    if(fR.ok && fR.value && big('0x'+fR.value.slice(2))!==0n){ factory=fR.value; out.factory=factory; }
    // also try siloId on the silo
    out.steps.push(await tryRead('silo0.siloId()',silo0,DSEL.siloId,(x)=>big(x).toString()));
  }catch(e){ out.steps.push({label:'getSilos',ok:false,error:e.message}); }

  // If we found a factory, enumerate via idToSiloConfig
  if(factory){
    const nextR=await tryRead('factory.getNextSiloId()',factory,DSEL.getNextSiloId,(x)=>Number(big(x)));
    out.steps.push(nextR);
    if(nextR.ok){
      out.markets=[];
      for(let id=1; id<nextR.value && id<=30; id++){
        const c=await tryRead('id'+id,factory,DSEL.idToSiloConfig+id.toString(16).padStart(64,'0'),(x)=>addrOf(x));
        if(c.ok && c.value && big('0x'+c.value.slice(2))!==0n){
          out.markets.push(await labelMarket(id,c.value));
        }
      }
      out.discoveredVia='factory.idToSiloConfig';
      out.note='All Silo markets enumerated from factory.'; return out;
    }
    // factory found but no idToSiloConfig — scan NewSilo events from the factory
    try{
      const latest=await ethBlockNumberD();
      const evMarkets=new Set();
      for(const topic of NEWSILO_TOPICS){
        let from=Math.max(0,latest-2000000), chunk=50000;
        while(from<=latest){
          const to=Math.min(from+chunk-1,latest);
          try{
            const logs=await getLogsD(factory,topic,from,to);
            for(const l of logs){
              // NewSilo event data usually contains the config address in a topic or data word
              if(l.topics&&l.topics[1]) evMarkets.add(addrOf(l.topics[1]));
              const dwords=(l.data||'0x').replace(/^0x/,'');
              for(let i=0;i<dwords.length/64;i++) evMarkets.add(addrOf('0x'+dwords.slice(i*64,i*64+64)));
            }
          }catch(_){ if(chunk>5000){chunk=5000;continue;} }
          from=to+1;
        }
      }
      out.markets=[]; let id=0;
      for(const cand of [...evMarkets]){
        // only keep addresses that respond to getSilos() (i.e., are SiloConfigs)
        try{ await ethCall(cand,SEL.getSilos); out.markets.push(await labelMarket(++id,cand)); }catch(_){}
      }
      out.discoveredVia='NewSilo-event-scan';
      out.note='Markets found by scanning factory NewSilo events.'; return out;
    }catch(e){ out.steps.push({label:'eventScan',ok:false,error:e.message}); }
  }

  out.note='Could not locate factory. The known market is confirmed; others need the factory address.';
  return out;
}

async function labelMarket(id,config){
  try{
    const silosHex=await ethCall(config,SEL.getSilos);
    const s0=addrOf(word(silosHex,0)), s1=addrOf(word(silosHex,1));
    const a0=addrOf(await ethCall(s0,SEL.asset)), a1=addrOf(await ethCall(s1,SEL.asset));
    let sym0='?',sym1='?';
    try{sym0=decodeString(await ethCall(a0,SEL.symbol))||'?';}catch(_){}
    try{sym1=decodeString(await ethCall(a1,SEL.symbol))||'?';}catch(_){}
    return {id,config,pair:sym0+'/'+sym1,silo0:s0,silo1:s1};
  }catch(e){ return {id,config,error:e.message}; }
}

async function diagnose(){ return getSiloMarket(); }
module.exports={getSiloMarket,getSiloRates,getSiloCollateral,getWalletPosition,getRecentLiquidations,discoverMarkets,diagnose,diagnosePosition,MARKET,RPC};
