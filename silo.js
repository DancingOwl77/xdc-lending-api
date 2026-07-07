/**
 * silo.js — Silo V3 XDC reader.
 * VERIFIED interface (from on-chain struct decode of market 0x0d41…5253):
 *   SiloConfig.getSilos() -> [siloWXDC 0x9ebc…, siloUSDC 0xd1ed…]
 *   SiloConfig.getConfig(silo) -> ConfigData struct:
 *     word3 = asset, word9 = interestRateModel, word10 = maxLtv(1e18),
 *     word11 = liquidationThreshold(1e18), word13 = liquidationFee(1e18)
 *   silo.getCollateralAssets()/getDebtAssets() -> supplied/borrowed (verified)
 * This build probes the IRM contracts directly for the rate function.
 */
const axios = require('axios');
const RPC    = process.env.XDC_RPC     || 'https://rpc.xinfin.network';
const MARKET = process.env.SILO_MARKET || '0x0d419DC8128D5738a62753DeB8eA3508AEd95253';

const SEL={getSilos:'0xaecc90cb',asset:'0x38d52e0f',symbol:'0x95d89b41',decimals:'0x313ce567',
  getCollateralAssets:'0xa1ff9bee',getDebtAssets:'0xecd658b4',getConfig:'0xe48a5f7b'};

const IRM_CANDIDATES={
 'getCurrentInterestRate(address,uint256)':'0x64efe177',
 'getCompoundInterestRate(address,uint256)':'0xcfdfcffa',
 'rcur(address,uint256)':'0xcb72cf34',
 'rcomp(address,uint256)':'0x6226a502',
 'getCurrentInterestRate(address)':'0xad951f1f',
};

async function ethCall(to,data){const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_call',params:[{to,data},'latest']},{timeout:12000,headers:{'Content-Type':'application/json'}});if(r.data.error)throw new Error(r.data.error.message||JSON.stringify(r.data.error));return r.data.result;}
const big=(h)=>BigInt(h&&h!=='0x'?h:'0x0');
const addrOf=(w)=>'0x'+w.replace(/^0x/,'').slice(-40);
const word=(hex,i)=>'0x'+hex.replace(/^0x/,'').slice(i*64,i*64+64);
const argAddr=(a)=>a.toLowerCase().replace(/^0x/,'').padStart(64,'0');
const argUint=(n)=>BigInt(n).toString(16).padStart(64,'0');
function decodeString(hex){const b=hex.replace(/^0x/,'');if(b.length<128)return null;const len=Number(BigInt('0x'+b.slice(64,128)));return Buffer.from(b.slice(128,128+len*2),'hex').toString('utf8').replace(/\x00+$/,'');}
async function probe(label,to,data,decode){try{const raw=await ethCall(to,data);return{label,ok:true,raw:raw.length>140?raw.slice(0,140)+'…':raw,value:decode?decode(raw):undefined};}catch(e){return{label,ok:false,error:e.message};}}

// pull IRM + LTV fields from the config struct for a silo
async function readConfig(silo){
  const raw=await ethCall(MARKET,SEL.getConfig+argAddr(silo));
  return {
    asset: addrOf(word(raw,3)),
    interestRateModel: addrOf(word(raw,9)),
    maxLtv: Number(big(word(raw,10)))/1e18,
    liquidationThreshold: Number(big(word(raw,11)))/1e18,
    liquidationFee: Number(big(word(raw,13)))/1e18,
  };
}

async function diagnose(){
  const out={market:MARKET,timestamp:new Date().toISOString(),silos:[]};
  const silosHex=await ethCall(MARKET,SEL.getSilos);
  const silos=[addrOf(word(silosHex,0)),addrOf(word(silosHex,1))];
  const nowTs=Math.floor(Date.now()/1000);
  for(const silo of silos){
    const cfg=await readConfig(silo);
    const g={silo,config:cfg,irmProbes:[]};
    const irm=cfg.interestRateModel;
    if(irm && big('0x'+irm.slice(2))!==0n){
      for(const [sig,s] of Object.entries(IRM_CANDIDATES)){
        const data = sig==='getCurrentInterestRate(address)' ? s+argAddr(silo)
                   : s+argAddr(silo)+argUint(nowTs);
        g.irmProbes.push(await probe('irm.'+sig,irm,data,(r)=>big(r).toString()));
      }
    }
    out.silos.push(g);
  }
  out.note='irm.* value is the per-second or annual rate, 1e18-scaled. getCurrentInterestRate is typically annual APR*1e18 -> divide by 1e16 for %.';
  return out;
}

// ── production reader with real APY once IRM fn is confirmed ──
let cache={data:null,at:0}; const TTL=60*1000;
let RATE_FN=null; // {selector, style} locked after discovery

async function readVault(silo){
  const cfg=await readConfig(silo);
  let symbol='?',decimals=18;
  try{symbol=decodeString(await ethCall(cfg.asset,SEL.symbol))||'?';}catch(_){}
  try{decimals=Number(big(await ethCall(cfg.asset,SEL.decimals)));}catch(_){}
  let supplied=0n,borrowed=0n;
  try{supplied=big(await ethCall(silo,SEL.getCollateralAssets));}catch(_){}
  try{borrowed=big(await ethCall(silo,SEL.getDebtAssets));}catch(_){}
  const d=10n**BigInt(decimals); const num=(v)=>Number(v*1000000n/(d||1n))/1000000;
  const s=num(supplied),b=num(borrowed);
  const util=s>0?b/s:0;

  let borrowAPY=null,supplyAPY=null;
  if(RATE_FN){
    try{
      const nowTs=Math.floor(Date.now()/1000);
      const data=RATE_FN.oneArg?RATE_FN.selector+argAddr(silo):RATE_FN.selector+argAddr(silo)+argUint(nowTs);
      const r=big(await ethCall(cfg.interestRateModel,data));
      borrowAPY=Number(r)/1e16; // 1e18 -> %
      supplyAPY=+(borrowAPY*util*(1-cfg.liquidationFee)).toFixed(2);
      borrowAPY=+borrowAPY.toFixed(2);
    }catch(_){}
  }
  return{silo,asset:symbol,assetAddress:cfg.asset,decimals,
    suppliedAssets:s,borrowedAssets:b,availableLiquidity:+(s-b).toFixed(6),
    utilization:+util.toFixed(4),maxLtv:cfg.maxLtv,liquidationThreshold:cfg.liquidationThreshold,
    liquidationFee:cfg.liquidationFee,borrowAPY,supplyAPY,interestRateModel:cfg.interestRateModel};
}
async function getSiloMarket(){
  const now=Date.now(); if(cache.data&&now-cache.at<TTL)return cache.data;
  const silosHex=await ethCall(MARKET,SEL.getSilos);
  const [v0,v1]=await Promise.all([readVault(addrOf(word(silosHex,0))),readVault(addrOf(word(silosHex,1)))]);
  const out={timestamp:new Date().toISOString(),network:'XDC Mainnet',dataSource:'silo-v3-onchain',protocol:'Silo Finance V3',market:MARKET,silos:[v0,v1]};
  cache={data:out,at:now}; return out;
}
function setRateFn(selector,oneArg){RATE_FN={selector,oneArg:!!oneArg};}
module.exports={diagnose,getSiloMarket,setRateFn,MARKET,RPC};
