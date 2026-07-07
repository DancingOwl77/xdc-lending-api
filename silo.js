/**
 * silo.js — Silo V3 on-chain reader for XDC. Interface verified empirically.
 * Confirmed working: SiloConfig.getSilos() -> [siloWXDC, siloUSDC];
 *   each silo: asset(), symbol(), decimals(), getCollateralAssets(), getDebtAssets().
 * This build ADDS an interest-rate discovery sweep to /silo/test.
 */
const axios = require('axios');

const RPC    = process.env.XDC_RPC     || 'https://rpc.xinfin.network';
const MARKET = process.env.SILO_MARKET || '0x0d419DC8128D5738a62753DeB8eA3508AEd95253';

const SEL = {
  getSilos:            '0xaecc90cb',
  asset:               '0x38d52e0f',
  symbol:              '0x95d89b41',
  decimals:            '0x313ce567',
  getCollateralAssets: '0xa1ff9bee',
  getDebtAssets:       '0xecd658b4',
  siloConfig:          '0xd714fd19', // siloConfig()
};

// Interest-rate discovery candidates
const RATE_NOARG = {
  'getCompoundInterestRate(uint256)': '0xea71f62d', // takes timestamp
  'getBorrowAPR()':                   '0x38b0056d',
  'getSupplyAPR()':                   '0xe85b5344',
  'borrowAPR()':                      '0x3a6515aa',
  'supplyAPR()':                      '0x649113a9',
  'rcomp()':                          '0x2e157a83',
};
const RATE_MODEL_FROM_CONFIG = {
  'config()':                  '0x79502c55',
  'getFeesWithAsset(address)': '0xa135e0a0',
  'getConfig(address)':        '0xe48a5f7b',
};
// IRM candidates (called on a rate-model addr, silo+ts args)
const IRM = {
  'getCurrentInterestRate(address,uint256)':  '0x64efe177',
  'getCompoundInterestRate(address,uint256)': '0xcfdfcffa',
  'rcur(address,uint256)':                    '0xcb72cf34',
};

async function ethCall(to, data){ const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data},'latest']},{timeout:12000,headers:{'Content-Type':'application/json'}}); if(r.data.error) throw new Error(r.data.error.message||JSON.stringify(r.data.error)); return r.data.result; }
async function ethGetCode(a){ const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_getCode',params:[a,'latest']},{timeout:12000,headers:{'Content-Type':'application/json'}}); return r.data.result||'0x'; }

const big=(h)=>BigInt(h&&h!=='0x'?h:'0x0');
const addrOf=(w)=>'0x'+w.replace(/^0x/,'').slice(-40);
const word=(hex,i)=>'0x'+hex.replace(/^0x/,'').slice(i*64,i*64+64);
const argAddr=(a)=>a.toLowerCase().replace(/^0x/,'').padStart(64,'0');
const argUint=(n)=>BigInt(n).toString(16).padStart(64,'0');
function decodeString(hex){const b=hex.replace(/^0x/,'');if(b.length<128)return null;const len=Number(BigInt('0x'+b.slice(64,128)));return Buffer.from(b.slice(128,128+len*2),'hex').toString('utf8').replace(/\x00+$/,'');}
async function probe(label,to,data,decode){try{const raw=await ethCall(to,data);return{label,ok:true,raw:raw.length>140?raw.slice(0,140)+'…':raw,value:decode?decode(raw):undefined};}catch(e){return{label,ok:false,error:e.message};}}

// ── production reader: real supplied/borrowed/utilization (verified) ──
let cache={data:null,at:0}; const TTL=60*1000;
async function readVault(silo){
  const assetAddr=addrOf(await ethCall(silo,SEL.asset));
  let symbol='?',decimals=18;
  try{symbol=decodeString(await ethCall(assetAddr,SEL.symbol))||'?';}catch(_){}
  try{decimals=Number(big(await ethCall(assetAddr,SEL.decimals)));}catch(_){}
  let supplied=0n,borrowed=0n;
  try{supplied=big(await ethCall(silo,SEL.getCollateralAssets));}catch(_){}
  try{borrowed=big(await ethCall(silo,SEL.getDebtAssets));}catch(_){}
  const d=10n**BigInt(decimals);
  const num=(v)=>Number(v*1000000n/(d||1n))/1000000;
  const s=num(supplied),b=num(borrowed);
  return{silo,asset:symbol,assetAddress:assetAddr,decimals,suppliedAssets:s,borrowedAssets:b,availableLiquidity:+(s-b).toFixed(6),utilization:s>0?+(b/s).toFixed(4):0};
}
async function getSiloMarket(){
  const now=Date.now(); if(cache.data&&now-cache.at<TTL)return cache.data;
  const silosHex=await ethCall(MARKET,SEL.getSilos);
  const silo0=addrOf(word(silosHex,0)), silo1=addrOf(word(silosHex,1));
  const [v0,v1]=await Promise.all([readVault(silo0),readVault(silo1)]);
  const out={timestamp:new Date().toISOString(),network:'XDC Mainnet',dataSource:'silo-v3-onchain',protocol:'Silo Finance V3',market:MARKET,silos:[v0,v1]};
  cache={data:out,at:now}; return out;
}

// ── rate discovery sweep for /silo/test ──
async function diagnose(){
  const out={market:MARKET,timestamp:new Date().toISOString(),rateDiscovery:[]};
  const silosHex=await ethCall(MARKET,SEL.getSilos);
  const silos=[addrOf(word(silosHex,0)),addrOf(word(silosHex,1))];
  out.silos=silos;
  const nowTs=Math.floor(Date.now()/1000);

  for(const silo of silos){
    const group={silo,probes:[]};
    // no-arg rate fns directly on the silo
    for(const [sig,s] of Object.entries(RATE_NOARG)){
      const data = sig.includes('uint256') ? s+argUint(nowTs) : s;
      group.probes.push(await probe(sig,silo,data,(r)=>big(r).toString()));
    }
    // discover rate-model / config from the silo
    for(const [sig,s] of Object.entries(RATE_MODEL_FROM_CONFIG)){
      const data = sig.includes('address') ? s+argAddr(silo) : s;
      group.probes.push(await probe(sig,silo,data,(r)=>r.length>140?r.slice(0,140)+'…':r));
    }
    // siloConfig() then IRM on the config
    try{
      const cfg=addrOf(await ethCall(silo,SEL.siloConfig));
      group.siloConfig=cfg;
      for(const [sig,s] of Object.entries(IRM)){
        group.probes.push(await probe('cfg.'+sig,cfg,s+argAddr(silo)+argUint(nowTs),(r)=>big(r).toString()));
      }
    }catch(e){ group.siloConfigError=e.message; }
    out.rateDiscovery.push(group);
  }
  out.hint='Look for any ok:true with a nonzero value. APR fns often return 1e18-scaled (divide by 1e16 for %). getCompoundInterestRate returns per-second rcomp (1e18-scaled).';
  return out;
}

module.exports={diagnose,getSiloMarket,MARKET,RPC};
