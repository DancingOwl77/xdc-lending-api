/**
 * silo.js — Silo V3 XDC reader.
 * VERIFIED: getSilos, asset, symbol, decimals, getCollateralAssets, getDebtAssets, config().
 * This build: definitive rate discovery — reads getInterestRateModel(silo) from the
 * SiloConfig, then calls getCurrentInterestRate on that model; plus dumps raw structs.
 */
const axios = require('axios');
const RPC    = process.env.XDC_RPC     || 'https://rpc.xinfin.network';
const MARKET = process.env.SILO_MARKET || '0x0d419DC8128D5738a62753DeB8eA3508AEd95253';

const SEL = {
  getSilos:'0xaecc90cb', asset:'0x38d52e0f', symbol:'0x95d89b41', decimals:'0x313ce567',
  getCollateralAssets:'0xa1ff9bee', getDebtAssets:'0xecd658b4',
  getInterestRateModel:'0x54a05771',       // getInterestRateModel(address silo) on SiloConfig
  getConfig:'0xe48a5f7b',                   // getConfig(address) -> ConfigData struct
};
// IRM (called on the model address)
const IRM = {
  'getCurrentInterestRate(address,uint256)':  '0x64efe177',
  'getCompoundInterestRate(address,uint256)': '0xcfdfcffa',
};

async function ethCall(to,data){const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data},'latest']},{timeout:12000,headers:{'Content-Type':'application/json'}});if(r.data.error)throw new Error(r.data.error.message||JSON.stringify(r.data.error));return r.data.result;}
const big=(h)=>BigInt(h&&h!=='0x'?h:'0x0');
const addrOf=(w)=>'0x'+w.replace(/^0x/,'').slice(-40);
const word=(hex,i)=>'0x'+hex.replace(/^0x/,'').slice(i*64,i*64+64);
const argAddr=(a)=>a.toLowerCase().replace(/^0x/,'').padStart(64,'0');
const argUint=(n)=>BigInt(n).toString(16).padStart(64,'0');
function decodeString(hex){const b=hex.replace(/^0x/,'');if(b.length<128)return null;const len=Number(BigInt('0x'+b.slice(64,128)));return Buffer.from(b.slice(128,128+len*2),'hex').toString('utf8').replace(/\x00+$/,'');}
async function probe(label,to,data,decode){try{const raw=await ethCall(to,data);return{label,ok:true,raw:raw.length>200?raw.slice(0,200)+'…':raw,value:decode?decode(raw):undefined};}catch(e){return{label,ok:false,error:e.message};}}

async function diagnose(){
  const out={market:MARKET,timestamp:new Date().toISOString(),silos:[]};
  const silosHex=await ethCall(MARKET,SEL.getSilos);
  const silos=[addrOf(word(silosHex,0)),addrOf(word(silosHex,1))];
  const nowTs=Math.floor(Date.now()/1000);

  for(const silo of silos){
    const g={silo,probes:[]};
    // 1. get the interest rate model address from the config for this silo
    const irmProbe=await probe('config.getInterestRateModel(silo)',MARKET,SEL.getInterestRateModel+argAddr(silo),addrOf);
    g.probes.push(irmProbe);

    // 2. if we got a model, call rate fns on it
    if(irmProbe.ok && irmProbe.value && /^0x[0-9a-f]{40}$/i.test(irmProbe.value) && big('0x'+irmProbe.value.slice(2))!==0n){
      const irm=irmProbe.value; g.interestRateModel=irm;
      for(const [sig,s] of Object.entries(IRM)){
        g.probes.push(await probe('irm.'+sig,irm,s+argAddr(silo)+argUint(nowTs),(r)=>big(r).toString()));
      }
    }

    // 3. dump the raw getConfig struct so we can read fields (maxLtv, lt, irm, fees) directly
    g.probes.push(await probe('config.getConfig(silo) RAW',MARKET,SEL.getConfig+argAddr(silo),(r)=>{
      const b=r.replace(/^0x/,''); const n=Math.floor(b.length/64);
      const words=[]; for(let i=0;i<Math.min(n,24);i++) words.push('0x'+b.slice(i*64,i*64+64));
      return {wordCount:n, first24Words:words};
    }));
    out.silos.push(g);
  }
  out.note='Reading IRM from config.getInterestRateModel(silo). If that reverts, the getConfig RAW words contain the model addr + LTV/LT fields to decode by position.';
  return out;
}

// production reader (verified reads only) — unchanged, real supplied/borrowed/util
let cache={data:null,at:0}; const TTL=60*1000;
async function readVault(silo){
  const assetAddr=addrOf(await ethCall(silo,SEL.asset));
  let symbol='?',decimals=18;
  try{symbol=decodeString(await ethCall(assetAddr,SEL.symbol))||'?';}catch(_){}
  try{decimals=Number(big(await ethCall(assetAddr,SEL.decimals)));}catch(_){}
  let supplied=0n,borrowed=0n;
  try{supplied=big(await ethCall(silo,SEL.getCollateralAssets));}catch(_){}
  try{borrowed=big(await ethCall(silo,SEL.getDebtAssets));}catch(_){}
  const d=10n**BigInt(decimals); const num=(v)=>Number(v*1000000n/(d||1n))/1000000;
  const s=num(supplied),b=num(borrowed);
  return{silo,asset:symbol,assetAddress:assetAddr,decimals,suppliedAssets:s,borrowedAssets:b,availableLiquidity:+(s-b).toFixed(6),utilization:s>0?+(b/s).toFixed(4):0};
}
async function getSiloMarket(){
  const now=Date.now(); if(cache.data&&now-cache.at<TTL)return cache.data;
  const silosHex=await ethCall(MARKET,SEL.getSilos);
  const [v0,v1]=await Promise.all([readVault(addrOf(word(silosHex,0))),readVault(addrOf(word(silosHex,1)))]);
  const out={timestamp:new Date().toISOString(),network:'XDC Mainnet',dataSource:'silo-v3-onchain',protocol:'Silo Finance V3',market:MARKET,silos:[v0,v1]};
  cache={data:out,at:now}; return out;
}
module.exports={diagnose,getSiloMarket,MARKET,RPC};
