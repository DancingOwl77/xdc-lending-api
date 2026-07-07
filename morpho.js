/**
 * morpho.js — Morpho Blue reader for XDC mainnet.
 * Singleton (same address all chains): 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
 * Markets are read by ID (bytes32). Discover market IDs by scanning CreateMarket events.
 *   market(id) -> (totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee)
 *   idToMarketParams(id) -> (loanToken, collateralToken, oracle, irm, lltv)
 * WAD-scaled (1e18). Utilization = totalBorrowAssets / totalSupplyAssets.
 */
const axios = require('axios');
const RPC = process.env.XDC_RPC || 'https://rpc.xinfin.network';
const MORPHO = process.env.MORPHO_SINGLETON || '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';

const SEL = {
  market:           '0x5c60e39a', // market(bytes32)
  idToMarketParams: '0x2c3c9157', // idToMarketParams(bytes32)
  symbol:'0x95d89b41', decimals:'0x313ce567',
};
const CREATE_MARKET_TOPICS = [
  '0xac4b2400f169220b0c0afdde7a0b32e775ba727ea1cb30b35f935cdaab8683ac', // CreateMarket(bytes32,(tuple))
  '0x0c93f98c4d9556735b225fc4375754833d94213dc489cc5b49180341bbae72e4', // CreateMarket(bytes32,addr,addr,addr,addr,uint256)
];

async function ethCall(to,data){const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data},'latest']},{timeout:12000,headers:{'Content-Type':'application/json'}});if(r.data.error)throw new Error(r.data.error.message||JSON.stringify(r.data.error));return r.data.result;}
async function ethGetCode(a){const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_getCode',params:[a,'latest']},{timeout:12000,headers:{'Content-Type':'application/json'}});return r.data.result||'0x';}
async function ethBlockNumber(){const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_blockNumber',params:[]},{timeout:10000,headers:{'Content-Type':'application/json'}});return parseInt(r.data.result,16);}
async function getLogs(address,topic,fromBlock,toBlock){const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_getLogs',params:[{address,topics:[topic],fromBlock:'0x'+fromBlock.toString(16),toBlock:'0x'+toBlock.toString(16)}]},{timeout:15000,headers:{'Content-Type':'application/json'}});if(r.data.error)throw new Error(r.data.error.message);return r.data.result||[];}

const big=(h)=>BigInt(h&&h!=='0x'?h:'0x0');
const addrOf=(w)=>'0x'+w.replace(/^0x/,'').slice(-40);
const wordAt=(hex,i)=>'0x'+hex.replace(/^0x/,'').slice(i*64,i*64+64);
const argBytes32=(id)=>id.replace(/^0x/,'').padStart(64,'0');
function decodeString(hex){const b=hex.replace(/^0x/,'');if(b.length<128)return null;const len=Number(BigInt('0x'+b.slice(64,128)));return Buffer.from(b.slice(128,128+len*2),'hex').toString('utf8').replace(/\x00+$/,'');}

async function tokenMeta(addr){
  let symbol='?',decimals=18;
  try{symbol=decodeString(await ethCall(addr,SEL.symbol))||'?';}catch(_){}
  try{decimals=Number(big(await ethCall(addr,SEL.decimals)));}catch(_){}
  return {symbol,decimals};
}

// Read one market by id
async function readMarket(id){
  const params = await ethCall(MORPHO, SEL.idToMarketParams + argBytes32(id));
  const loanToken       = addrOf(wordAt(params,0));
  const collateralToken = addrOf(wordAt(params,1));
  const irm             = addrOf(wordAt(params,3));
  const lltv            = Number(big(wordAt(params,4)))/1e18;

  const state = await ethCall(MORPHO, SEL.market + argBytes32(id));
  const totalSupplyAssets = big(wordAt(state,0));
  const totalBorrowAssets = big(wordAt(state,2));

  const loan = await tokenMeta(loanToken);
  const coll = await tokenMeta(collateralToken);
  const d = 10n**BigInt(loan.decimals);
  const num=(v)=>Number(v*1000000n/(d||1n))/1000000;
  const supplied = num(totalSupplyAssets);
  const borrowed = num(totalBorrowAssets);
  const utilization = supplied>0 ? +(borrowed/supplied).toFixed(4) : 0;

  return {
    id, pair: coll.symbol+'/'+loan.symbol,
    loanToken:{address:loanToken,symbol:loan.symbol,decimals:loan.decimals},
    collateralToken:{address:collateralToken,symbol:coll.symbol,decimals:coll.decimals},
    lltv, irm,
    totalSupplied:+supplied.toFixed(6), totalBorrowed:+borrowed.toFixed(6),
    availableLiquidity:+(supplied-borrowed).toFixed(6), utilization,
  };
}

// Discover markets via CreateMarket events on the singleton
let _mCache={list:null,at:0}; const MTTL=30*60*1000;
async function discoverMarketIds(){
  const now=Date.now(); if(_mCache.list&&now-_mCache.at<MTTL)return _mCache.list;
  const latest=await ethBlockNumber();
  const ids=new Set(); let capped=false;
  for(const topic of CREATE_MARKET_TOPICS){
    let from=Math.max(0,latest-3000000), chunk=100000;
    while(from<=latest){
      const to=Math.min(from+chunk-1,latest);
      try{
        const logs=await getLogs(MORPHO,topic,from,to);
        for(const l of logs){ if(l.topics&&l.topics[1]) ids.add(l.topics[1]); }
      }catch(e){ if(chunk>10000){chunk=10000;continue;} capped=true; }
      from=to+1;
    }
  }
  const list=[...ids]; _mCache={list,at:now}; list._capped=capped;
  return list;
}

async function diagnose(){
  const out={singleton:MORPHO,timestamp:new Date().toISOString()};
  const code=await ethGetCode(MORPHO);
  out.singletonHasCode = code.length>2;
  out.codeLen = code.length;
  if(!out.singletonHasCode){ out.fatal='Morpho singleton has no code on XDC RPC'; return out; }
  const ids=await discoverMarketIds();
  out.marketIdsFound=ids.length;
  out.markets=[];
  for(const id of ids.slice(0,30)){
    try{ out.markets.push(await readMarket(id)); }catch(e){ out.markets.push({id,error:e.message}); }
  }
  out.note = ids.length===0
    ? 'Morpho singleton is deployed on XDC but no CreateMarket events found in scanned range — no active markets yet.'
    : 'Morpho markets discovered on XDC.';
  return out;
}

let cache={data:null,at:0}; const TTL=60*1000;
async function getMorphoMarket(){
  const now=Date.now(); if(cache.data&&now-cache.at<TTL)return cache.data;
  const ids=await discoverMarketIds();
  const markets=[];
  for(const id of ids){ try{ const m=await readMarket(id); if(m.totalSupplied>0) markets.push(m); }catch(_){} }
  const out={timestamp:new Date().toISOString(),network:'XDC Mainnet',dataSource:'morpho-blue-onchain',
    protocol:'Morpho Blue',singleton:MORPHO,marketsCount:markets.length,markets};
  cache={data:out,at:now}; return out;
}

async function getMorphoRates(){
  const m=await getMorphoMarket();
  if(!m.markets.length) return null;
  return m.markets.map(mk=>({protocol:'Morpho Blue ('+mk.pair+')',type:'Isolated Lending (Morpho Blue)',
    market:mk.id, pair:mk.pair, dataSource:'morpho-blue-onchain',
    assets:[{asset:mk.loanToken.symbol, supplyAPY:null, borrowAPY:null, utilization:mk.utilization,
      suppliedAssets:mk.totalSupplied, borrowedAssets:mk.totalBorrowed, availableLiquidity:mk.availableLiquidity,
      maxLtv:mk.lltv, liquidationThreshold:mk.lltv}]}));
}

module.exports={getMorphoMarket,getMorphoRates,discoverMarketIds,diagnose,MORPHO};
