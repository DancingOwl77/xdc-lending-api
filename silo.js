/**
 * silo.js — Silo V3 on-chain reader / prober for XDC mainnet.
 * Selectors computed via keccak (verified), not guessed.
 */
const axios = require('axios');

const RPC    = process.env.XDC_RPC     || 'https://rpc.xinfin.network';
const MARKET = process.env.SILO_MARKET || '0x0d419DC8128D5738a62753DeB8eA3508AEd95253';

const SEL = {
  'getSilos()':        '0xaecc90cb',
  'silos()':           '0x9cfe1dac',
  'config()':          '0x79502c55',
  'factory()':         '0xc45a0155',
  'asset()':           '0x38d52e0f',
  'token()':           '0xfc0c546a',
  'silo()':            '0xeb3beb29',
  'getCollateralAssets()': '0xa1ff9bee',
  'getDebtAssets()':   '0xecd658b4',
  'totalAssets()':     '0x01e1d114',
  'totalSupply()':     '0x18160ddd',
  'getLiquidity()':    '0x0910a510',
  'symbol()':          '0x95d89b41',
  'name()':            '0x06fdde03',
  'decimals()':        '0x313ce567',
};
// getSilo(uint256) with arg 0 and 1
const GET_SILO = '0x94720da3';
const argUint = (n) => n.toString(16).padStart(64,'0');

async function ethCall(to, data) {
  const r = await axios.post(RPC, { jsonrpc:'2.0', id:1, method:'eth_call', params:[{to,data},'latest'] },
    { timeout: 12000, headers: {'Content-Type':'application/json'} });
  if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
  return r.data.result;
}
async function ethGetCode(a){ const r=await axios.post(RPC,{jsonrpc:'2.0',id:1,method:'eth_getCode',params:[a,'latest']},{timeout:12000,headers:{'Content-Type':'application/json'}}); return r.data.result||'0x'; }

const big=(h)=>BigInt(h&&h!=='0x'?h:'0x0');
const addrOf=(w)=>'0x'+w.replace(/^0x/,'').slice(-40);
const word=(hex,i)=>'0x'+hex.replace(/^0x/,'').slice(i*64,i*64+64);
function decodeString(hex){const b=hex.replace(/^0x/,'');if(b.length<128)return null;const len=Number(BigInt('0x'+b.slice(64,128)));return Buffer.from(b.slice(128,128+len*2),'hex').toString('utf8').replace(/\x00+$/,'');}

async function probe(label,to,data,decode){
  try{ const raw=await ethCall(to,data); return {label,ok:true,raw:raw.length>200?raw.slice(0,200)+'…':raw,value:decode?decode(raw):undefined}; }
  catch(e){ return {label,ok:false,error:e.message}; }
}

// Sweep every candidate selector on the market to discover its interface
async function diagnose(){
  const out={market:MARKET,rpc:RPC,timestamp:new Date().toISOString()};
  const code=await ethGetCode(MARKET);
  out.marketCodeLen=code.length;
  if(code.length<=2){out.fatal='no code at market';return out;}

  // 1. sweep no-arg selectors on the market
  out.marketProbes=[];
  for(const [sig,data] of Object.entries(SEL)){
    const dec = sig==='asset()'||sig==='token()'||sig==='silo()'||sig==='config()'||sig==='factory()' ? addrOf
              : sig==='symbol()'||sig==='name()' ? decodeString
              : sig==='decimals()' ? (r)=>Number(big(r))
              : sig==='getSilos()' ? (r)=>({silo0:addrOf(word(r,0)),silo1:addrOf(word(r,1))})
              : (r)=>big(r).toString();
    out.marketProbes.push(await probe(sig,MARKET,data,dec));
  }
  // 2. getSilo(0) / getSilo(1)
  out.marketProbes.push(await probe('getSilo(0)',MARKET,GET_SILO+argUint(0),addrOf));
  out.marketProbes.push(await probe('getSilo(1)',MARKET,GET_SILO+argUint(1),addrOf));

  // 3. collect any discovered silo/vault addresses and probe them as vaults
  const found=new Set();
  for(const p of out.marketProbes){
    if(!p.ok) continue;
    if(p.label==='getSilos()'&&p.value){found.add(p.value.silo0);found.add(p.value.silo1);}
    if(['getSilo(0)','getSilo(1)','silo()'].includes(p.label)&&typeof p.value==='string'&&p.value!=='0x0000000000000000000000000000000000000000')found.add(p.value);
  }
  out.discoveredSilos=[...found];
  out.vaults=[];
  for(const v of found){
    const vault={address:v,reads:[]};
    const a=await probe('asset()',v,SEL['asset()'],addrOf); vault.reads.push(a);
    if(a.ok){vault.reads.push(await probe('sym',a.value,SEL['symbol()'],decodeString));vault.reads.push(await probe('dec',a.value,SEL['decimals()'],(r)=>Number(big(r))));}
    vault.reads.push(await probe('getCollateralAssets()',v,SEL['getCollateralAssets()'],(r)=>big(r).toString()));
    vault.reads.push(await probe('getDebtAssets()',v,SEL['getDebtAssets()'],(r)=>big(r).toString()));
    vault.reads.push(await probe('totalAssets()',v,SEL['totalAssets()'],(r)=>big(r).toString()));
    out.vaults.push(vault);
  }

  out.summary={
    marketFunctionsFound: out.marketProbes.filter(p=>p.ok).map(p=>p.label),
    silosDiscovered: out.discoveredSilos.length,
    vaultsReadable: out.vaults.filter(v=>v.reads.find(r=>r.label==='asset()'&&r.ok)).length,
  };
  return out;
}

module.exports={diagnose,MARKET,RPC};
