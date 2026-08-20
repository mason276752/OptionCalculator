#!/usr/bin/env node
// 給定「目標曝險金額」與「到期日」，反推該買哪個履約價的買權、要幾口、合約價多少。
//
//   node solve-exposure.mjs --exposure 100000 --dte 400
//   node solve-exposure.mjs --exposure 100000 --expiry 2027-09-17
//   node solve-exposure.mjs --exposure 100000 --dte 400 --budget 25000
//   node solve-exposure.mjs --symbol SPY --exposure 50000 --dte 180 --put
//   node solve-exposure.mjs --list-expiries
//
// 曝險採 Delta 口徑：曝險 = Delta × 現價 × 口數 × 合約乘數，
// 也就是這個部位「等同於持有多少市值的標的」，而非名目本金。
//
// 每個履約價的 IV 都由它自己的市場中價反解，不共用一個 IV——
// 波動率偏斜會讓價外選擇權的理論價明顯偏離，共用單一 IV 算出來的合約價不能用。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadMarket, fetchChain, groupByExpiry, listExpiries, todayUtc, quoteOf } from "./market-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HELP = `用法：node solve-exposure.mjs --exposure 100000 [選項]

必要
  --exposure N       目標曝險金額（Delta 等值的標的市值）

指定到期（擇一，預設最近的 1 月 LEAPS）
  --dte N            想要的到期天數，會挑鏈上最接近的
  --expiry DATE      指定到期日 YYYY-MM-DD

其他
  --symbol SYM       標的，預設 QQQ
  --budget N         總成本上限，超過的履約價不列出
  --put              改用賣權建立空方曝險
  --mult N           合約乘數，預設 100
  --delta-min N      Delta 下限，預設 0.20（愈低愈價外）
  --delta-max N      Delta 上限，預設 0.85
  --min-oi N         未平倉量下限，預設 10，濾掉沒人交易、中價不可信的履約價
  --all              列出區間內每一個履約價，不抽樣
  --list-expiries    只列出可選的到期日
  --help`;

function parseArgs(argv){
  const o = {symbol:"QQQ", exposure:null, dte:null, expiry:null, budget:null,
             cp:"call", mult:100, deltaMin:0.20, deltaMax:0.85, minOi:10, all:false, listExpiries:false};
  for(let i = 0; i < argv.length; i++){
    const a = argv[i];
    if(a === "--symbol")            o.symbol = argv[++i].toUpperCase();
    else if(a === "--exposure")     o.exposure = +argv[++i];
    else if(a === "--dte")          o.dte = +argv[++i];
    else if(a === "--expiry")       o.expiry = argv[++i];
    else if(a === "--budget")       o.budget = +argv[++i];
    else if(a === "--mult")         o.mult = +argv[++i];
    else if(a === "--delta-min")    o.deltaMin = +argv[++i];
    else if(a === "--delta-max")    o.deltaMax = +argv[++i];
    else if(a === "--min-oi")       o.minOi = +argv[++i];
    else if(a === "--all")          o.all = true;
    else if(a === "--put")          o.cp = "put";
    else if(a === "--list-expiries") o.listExpiries = true;
    else if(a === "--help"){ console.log(HELP); process.exit(0); }
    else throw new Error(`未知參數：${a}`);
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));

if(args.listExpiries){
  const chain = await fetchChain(args.symbol);
  const rows = listExpiries(groupByExpiry(chain.data.options), todayUtc());
  console.log(`${args.symbol} 現價 ${chain.data.current_price}／可選到期日：\n`);
  for(const r of rows) console.log(`  ${r.e}   ${String(r.dte).padStart(4)} 天`);
  process.exit(0);
}

if(!(args.exposure > 0)){ console.error("請用 --exposure 指定目標曝險金額\n"); console.log(HELP); process.exit(1); }

const htmlPath = join(HERE, "index.html");
const m = await loadMarket({
  symbol:args.symbol, expiry:args.expiry, dte:args.dte, minDte:365, htmlPath, log:console.log
});
const {spot, expiry, dte, T, r, q, pricer:{bs, impliedVol}} = m;
const wantCall = args.cp === "call";

console.log(`  現價 ${spot}｜到期 ${expiry}（剩 ${dte} 天）｜利率 ${r}%｜股息 ${q}%`);
console.log(`  目標曝險 ${args.exposure.toLocaleString("zh-TW")}｜${wantCall ? "買進買權" : "買進賣權"}\n`);

// 逐一履約價：由該檔的市場中價反解自己的 IV，再用同一套模型算 Delta
const rows = [];
for(const c of m.byExp.get(expiry)){
  if(c.cp !== (wantCall ? "C" : "P")) continue;
  const qt = quoteOf(c);
  if(!qt || qt.price <= 0) continue;
  if(c.open_interest < args.minOi) continue;    // 沒人持有的履約價中價不可信，價差通常大得離譜

  const solved = impliedVol(args.cp, spot, c.K, T, r/100, q/100, qt.price);
  if(solved === null) continue;                       // 報價低於內含價值，多半是沒人掛的殭屍檔
  const g = bs(args.cp, spot, c.K, T, r/100, q/100, solved);
  const absDelta = Math.abs(g.delta);
  if(absDelta < args.deltaMin || absDelta > args.deltaMax) continue;

  const perContract = g.delta*spot*args.mult;         // 每口的 Delta 曝險
  const qty = Math.max(1, Math.round(args.exposure/Math.abs(perContract)));
  const exposure = perContract*qty;
  const cost = qt.price*args.mult*qty;
  if(args.budget != null && cost > args.budget) continue;

  const theta = g.theta*args.mult*qty;                 // 每日時間價值（整個部位）
  const dev = (Math.abs(exposure) - args.exposure)/args.exposure;
  rows.push({
    K:c.K, price:qt.price, basis:qt.basis, iv:solved*100, delta:g.delta, absDelta,
    perContract, qty, exposure, cost,
    lev:Math.abs(exposure)/cost,                       // 資金槓桿＝波動倍數（買進當下兩者必然相等）
    theta,
    carry:Math.abs(theta)/cost*100,                    // 每天燒掉本金的百分比
    dev, err:Math.abs(dev),
    oi:c.open_interest
  });
}
if(!rows.length){
  console.error("沒有符合條件的履約價" + (args.budget != null ? "（可能是 --budget 太緊）" : ""));
  process.exit(1);
}
rows.sort((a, b) => a.K - b.K);

// 每個履約價都湊得出目標曝險，多買幾口就是了；真正要選的是取捨。
// 因此標記的不是「最接近目標」（那只會挑到口數最多的深價外樂透票），
// 而是這條光譜上的三個代表點。
const nearestTo = (list, pick, target) => list.reduce((a, b) =>
  Math.abs(pick(b) - target) < Math.abs(pick(a) - target) ? b : a);

// 口數只能取整數，深價內一口的曝險就很大；目標太小時整排都會超標。
// 代表點只從打得中目標的列裡挑，否則會推薦一個超標七成的部位。
const FIT = 0.15;
const fitting = rows.filter(x => x.err <= FIT);
const pool = fitting.length ? fitting : rows;

const atm      = nearestTo(pool, x => x.absDelta, 0.50);   // 接近價平，最像「用選擇權替代持股」
const cheapest = pool.reduce((a, b) => b.cost < a.cost ? b : a);
const steady   = pool.reduce((a, b) => b.carry < a.carry ? b : a);  // 每日損耗佔本金最低

const n = (v, d = 0) => v.toLocaleString("zh-TW", {minimumFractionDigits:d, maximumFractionDigits:d});
const pad = (s, w) => String(s).padStart(w);

// 抽樣，讓 Delta 區間均勻呈現而不是刷滿整個螢幕
let shown = rows;
if(!args.all && rows.length > 18){
  const step = (rows.length - 1)/17;
  const idx = new Set([...Array(18)].map((_, i) => Math.round(i*step)));
  for(const x of [atm, cheapest, steady]) idx.add(rows.indexOf(x));
  shown = [...idx].sort((a, b) => a - b).map(i => rows[i]);
}

console.log("      履約價   合約價     IV   Delta  口數      實際曝險    誤差      總成本    槓桿  每日耗損      OI");
console.log("  " + "─".repeat(104));
for(const x of shown){
  const mark = x === atm ? "◆" : x === cheapest ? "○" : x === steady ? "△" : " ";
  const dev = (x.dev >= 0 ? "+" : "−") + n(Math.abs(x.dev)*100, 0) + "%";
  console.log(
    `  ${mark} ${pad(n(x.K, 0), 6)} ${pad(n(x.price, 2), 8)} ${pad(n(x.iv, 1) + "%", 6)} ` +
    `${pad(n(x.delta, 3), 7)} ${pad(x.qty, 5)} ${pad(n(x.exposure), 13)} ${pad(dev, 7)}` +
    `${x.err > FIT ? "!" : " "}${pad(n(x.cost), 10)} ` +
    `${pad(n(x.lev, 2) + "×", 7)} ${pad(n(x.carry, 2) + "%", 9)} ${pad(n(x.oi), 7)}`);
}
console.log("  " + "─".repeat(104));
if(!fitting.length)
  console.log(`  ⚠ 目標曝險比任何一個履約價買一口的曝險都小，整張表最少都得買一口、必然超標。`);
else if(rows.length !== fitting.length)
  console.log(`  ! 標記＝口數取整後偏離目標超過 ±${FIT*100}%，不列入代表點`);
if(shown.length < rows.length)
  console.log(`  區間內共 ${rows.length} 個履約價，已抽樣顯示 ${shown.length} 個（--all 看全部）`);
console.log("  ◆ 接近價平    ○ 總成本最低    △ 每日耗損佔本金最低");
console.log("  「每日耗損」＝ Theta ÷ 總成本，是這筆錢每天燒掉的百分比");

// 產生可直接開啟計算機的網址片段
function hashFor(x){
  const state = {
    S:spot, dte, iv:+x.iv.toFixed(2), mult:args.mult, r, q, rangePct:35, tRem:dte,
    legs:[{id:1, type:args.cp, side:1, K:x.K, premium:x.price, qty:x.qty, iv:+x.iv.toFixed(2)}]
  };
  return "#" + Buffer.from(JSON.stringify(state)).toString("base64");
}

const picks = [
  ["接近價平", atm, "最像用選擇權替代持股，內含價值厚、歸零風險低"],
  ["總成本最低", cheapest, "壓低佔用資金，但價外程度高、到期歸零的機率大"],
  ["每日耗損最低", steady, "同樣的曝險下，時間價值每天燒得最慢"]
];
const seen = new Set();
for(const [title, x, why] of picks){
  if(seen.has(x)) continue;
  seen.add(x);
  console.log(`\n【${title}】履約價 ${n(x.K, 0)}，合約價 ${n(x.price, 2)}，買 ${x.qty} 口`);
  console.log(`  投入 ${n(x.cost)} → 曝險 ${n(x.exposure)}（目標 ${n(args.exposure)}，差 ${n(x.err*100, 1)}%）`);
  console.log(`  Delta ${n(x.delta, 3)}｜IV ${n(x.iv, 1)}%｜每天燒 ${n(Math.abs(x.theta), 1)}（本金的 ${n(x.carry, 2)}%）`);
  console.log(`  ${why}`);
  console.log(`  在計算機中開啟：index.html${hashFor(x)}`);
}

console.log(`\n注意`);
console.log(`  · 每個履約價都湊得出目標曝險，差別在成本、耗損與歸零風險，沒有單一「正確答案」。`);
console.log(`  · 曝險是 Delta 口徑的瞬時值，標的一動 Delta 就變，需要定期再平衡。`);
console.log(`  · 合約價取自${atm.basis}，實際成交落在買賣價之間；OI 太低的履約價滑價會很明顯。`);
console.log(`  · 每個履約價的 IV 都由它自己的中價反解，已反映波動率偏斜，不是共用一個 IV。`);
console.log(`  · 表中「槓桿」同時就是波動倍數——買進當下成本等於現值，兩個數字必然相等。`);
