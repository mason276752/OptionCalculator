#!/usr/bin/env node
// 抓取多個標的的選擇權鏈與公債殖利率，寫入 market.json / chain.json。
// 頁面（src/lib/data.js）直接 import 這兩份檔案，因此更新完就是新的預設值。
//
//   node fetch-market.mjs                              # 預設六個標的
//   node fetch-market.mjs --symbols QQQ,SPY
//   node fetch-market.mjs --expiry 2028-01-21          # 指定到期日（所有標的共用）
//   node fetch-market.mjs --min-dte 180                # 放寬預設到期日的最短天期
//   node fetch-market.mjs --no-write                   # 只印出結果，不改檔案

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadMarket, buildChainSummary } from "./market-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// QQQ／SPY 是本尊，其餘為 2 倍與 3 倍槓桿 ETF
const DEFAULT_SYMBOLS = ["QQQ", "QLD", "TQQQ", "SPY", "SSO", "SPXL"];
const HELP = `用法：node fetch-market.mjs [--symbols QQQ,SPY,…] [--expiry YYYY-MM-DD] [--min-dte 365] [--no-write]
預設標的：${DEFAULT_SYMBOLS.join(", ")}`;

function parseArgs(argv){
  const o = {symbols:DEFAULT_SYMBOLS, expiry:null, minDte:365, write:true};
  for(let i = 0; i < argv.length; i++){
    const a = argv[i];
    if(a === "--symbols")       o.symbols = argv[++i].toUpperCase().split(",").map(s => s.trim()).filter(Boolean);
    else if(a === "--symbol")   o.symbols = [argv[++i].toUpperCase()];
    else if(a === "--expiry")   o.expiry = argv[++i];
    else if(a === "--min-dte")  o.minDte = +argv[++i];
    else if(a === "--no-write") o.write = false;
    else if(a === "--help"){ console.log(HELP); process.exit(0); }
    else throw new Error(`未知參數：${a}`);
  }
  return o;
}

async function fetchOne(symbol, args){
  const m = await loadMarket({symbol, expiry:args.expiry, minDte:args.minDte});
  const {spot, expiry, dte, T, atm, r, q, qNote, pricer:{bs, impliedVol}} = m;
  const {K, call, put, callQuote, putQuote} = atm;
  const callMid = callQuote.price, putMid = putQuote.price;
  const priceBasis = callQuote.basis === putQuote.basis
    ? callQuote.basis
    : `買權${callQuote.basis}／賣權${putQuote.basis}`;

  // CBOE 每檔合約的 iv 是他們自己的模型算的，套進本頁的歐式 BS 無法重現中價；
  // 改用同一套模型從中價反解，理論價才會對得上。
  const ivCboe = +(call.iv*100).toFixed(2);
  const solved = impliedVol("call", spot, K, T, r/100, q/100, callMid);
  if(solved === null) throw new Error(`中價 ${callMid} 無法反解 IV（可能低於內含價值）`);
  const iv = +(solved*100).toFixed(2);
  const check = bs("call", spot, K, T, r/100, q/100, solved).price;
  if(Math.abs(check - callMid) > 0.01) throw new Error(`IV 反解自我檢查失敗：${check} ≠ ${callMid}`);
  if(!(iv > 1 && iv < 300)) throw new Error(`IV 超出合理範圍：${iv}%`);

  const detail = {
    asOf: m.chain.timestamp ?? new Date().toISOString(),
    symbol, spot, expiry, dte, strike:K, iv, ivCboe,
    iv30: m.chain.data.iv30, r, q, callMid, putMid,
    call: {bid:call.bid, ask:call.ask, theo:call.theo, delta:call.delta, openInterest:call.open_interest},
    put:  {bid:put.bid,  ask:put.ask,  theo:put.theo,  delta:put.delta,  openInterest:put.open_interest},
    priceBasis, parYield:m.parYield, yieldCurveDate:m.curveDate, dividendYieldNote:qNote
  };
  const summary = buildChainSummary(m);
  const strikes = summary.expiries.reduce((a, x) => a + x.rows.length, 0);

  console.log(`  ${symbol.padEnd(5)} ${String(spot).padStart(8)}｜${expiry}（${dte} 天）｜K ${K}｜`
    + `IV ${iv}%｜${summary.expiries.length} 個到期日、${strikes} 個履約價｜${priceBasis}`);
  return {detail, summary};
}

const args = parseArgs(process.argv.slice(2));

console.log(`抓取 ${args.symbols.length} 個標的的選擇權鏈與公債殖利率…`);
const results = {}, failed = [];
for(const sym of args.symbols){
  try{ results[sym] = await fetchOne(sym, args); }
  catch(e){ failed.push(sym); console.log(`  ${sym.padEnd(5)} 失敗：${e.message}`); }
}
if(!Object.keys(results).length) throw new Error("所有標的都抓取失敗，不更新任何檔案");
if(failed.length) console.log(`\n⚠ ${failed.join("、")} 抓取失敗，本次沿用不到這些標的的資料`);

const market = {
  fetchedAt: new Date().toISOString(),
  symbols: Object.fromEntries(Object.entries(results).map(([s, r]) => [s, r.detail])),
  sources: {
    chain: "https://cdn.cboe.com/api/global/delayed_quotes/options/<SYMBOL>.json",
    yieldCurve: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve"
  }
};
const chains = Object.fromEntries(Object.entries(results).map(([s, r]) => [s, r.summary]));

if(!args.write){
  console.log("\n--no-write：未寫入檔案");
  process.exit(0);
}

await writeFile(join(HERE, "market.json"), JSON.stringify(market, null, 2) + "\n");
await writeFile(join(HERE, "chain.json"), JSON.stringify(chains) + "\n");
console.log(`\n已寫入 market.json 與 chain.json（${Object.keys(results).join("、")}）`);
// 這兩份 JSON 由 src/lib/data.js 直接 import，打包時就會帶進頁面；
// 過去要另外把資料嵌回 index.html 的標記區塊，改成 Vue 專案之後不再需要。
