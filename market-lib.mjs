// 抓取與定價的共用模組，由 fetch-market.mjs 與 solve-exposure.mjs 共同使用。
//
// 資料來源皆為公開端點，不需金鑰：
//   選擇權鏈  CBOE 延遲報價 CDN
//   公債殖利率 美國財政部 Daily Treasury Par Yield Curve

import { readFile } from "node:fs/promises";

export const DAY = 86400000;

export function todayUtc(){
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

async function get(url, label){
  const res = await fetch(url, {headers:{"user-agent":"leapscalc/1.0"}, signal:AbortSignal.timeout(60000)});
  if(!res.ok) throw new Error(`${label} 回應 ${res.status}`);
  return res;
}
const getJson = async (url, label) => (await get(url, label)).json();
const getText = async (url, label) => (await get(url, label)).text();

/* ---------- 選擇權鏈 ---------- */
// CBOE 的 OCC 代碼：根代碼 + YYMMDD + C/P + 8 位履約價（千分之一美元）
const OCC = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

export async function fetchChain(symbol){
  // 指數類（SPX、VIX…）的檔名前面多一條底線
  for(const name of [symbol, "_" + symbol]){
    try{
      const j = await getJson(`https://cdn.cboe.com/api/global/delayed_quotes/options/${name}.json`, "CBOE");
      if(j?.data?.options?.length) return j;
    }catch(e){ if(name === "_" + symbol) throw e; }
  }
  throw new Error(`CBOE 查無 ${symbol} 的選擇權鏈`);
}

export function groupByExpiry(options){
  const byExp = new Map();
  for(const o of options){
    const m = o.option.match(OCC);
    if(!m) continue;
    const expiry = `20${m[2]}-${m[3]}-${m[4]}`;
    if(!byExp.has(expiry)) byExp.set(expiry, []);
    byExp.get(expiry).push({cp:m[5], K:+m[6]/1000, ...o});
  }
  return byExp;
}

export function listExpiries(byExp, today){
  return [...byExp.keys()]
    .map(e => ({e, dte:Math.round((new Date(e + "T00:00:00Z") - today)/DAY)}))
    .sort((a, b) => a.dte - b.dte);
}

// 預設挑「到期天數達門檻、最近的一個 1 月到期」——也就是標準 LEAPS。
// 給了 expiry 就用指定的；給了 dte 就挑天數最接近的。
export function pickExpiry(byExp, {expiry, dte, minDte = 0}, today){
  const all = listExpiries(byExp, today);
  if(expiry){
    const hit = all.find(x => x.e === expiry);
    if(!hit) throw new Error(`鏈上沒有 ${expiry}，可選：${all.map(x => `${x.e}(${x.dte}天)`).join(", ")}`);
    return hit;
  }
  if(dte != null){
    const hit = [...all].sort((a, b) => Math.abs(a.dte - dte) - Math.abs(b.dte - dte))[0];
    if(!hit) throw new Error("鏈上沒有任何到期日");
    return hit;
  }
  const far = all.filter(x => x.dte >= minDte);
  if(!far.length) throw new Error(`沒有到期天數 ≥ ${minDte} 的合約`);
  return far.find(x => x.e.slice(5, 7) === "01") ?? far[0];
}

// 盤前／盤後常常整排沒掛單，因此依序退而求其次
export function quoteOf(c){
  if(c.bid > 0 && c.ask > 0) return {price:+((c.bid + c.ask)/2).toFixed(2), basis:"買賣價中價", rank:0};
  if(c.theo > 0) return {price:+c.theo.toFixed(2), basis:"CBOE 理論價", rank:1};
  if(c.last_trade_price > 0) return {price:+c.last_trade_price.toFixed(2), basis:"最後成交價", rank:2};
  return null;
}

// 取最接近現價、且買賣權都報得出價的履約價；有真實掛單的優先
export function pickAtm(contracts, spot){
  const byStrike = new Map();
  for(const c of contracts){
    const q = quoteOf(c);
    if(!q) continue;
    if(!byStrike.has(c.K)) byStrike.set(c.K, {});
    byStrike.get(c.K)[c.cp] = {contract:c, quote:q};
  }
  const pairs = [...byStrike.entries()].filter(([, v]) => v.C && v.P);
  if(!pairs.length) throw new Error("該到期日找不到同時報得出買權與賣權價格的履約價");
  pairs.sort((a, b) => {
    const rank = x => Math.max(x[1].C.quote.rank, x[1].P.quote.rank);
    return (rank(a) - rank(b)) || (Math.abs(a[0] - spot) - Math.abs(b[0] - spot));
  });
  const [K, {C, P}] = pairs[0];
  return {K, call:C.contract, put:P.contract, callQuote:C.quote, putQuote:P.quote};
}

/* ---------- 公債殖利率 ---------- */
const TENORS = [
  ["BC_1MONTH", 1/12], ["BC_2MONTH", 2/12], ["BC_3MONTH", 0.25], ["BC_4MONTH", 4/12],
  ["BC_6MONTH", 0.5], ["BC_1YEAR", 1], ["BC_2YEAR", 2], ["BC_3YEAR", 3],
  ["BC_5YEAR", 5], ["BC_7YEAR", 7], ["BC_10YEAR", 10], ["BC_20YEAR", 20], ["BC_30YEAR", 30]
];

export async function fetchYieldCurve(today){
  // 月初可能還沒有當月資料，往前一個月再試一次
  for(const back of [0, 1]){
    const d = new Date(today);
    d.setUTCMonth(d.getUTCMonth() - back);
    const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const xml = await getText(
      "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml" +
      `?data=daily_treasury_yield_curve&field_tdr_date_value_month=${ym}`, "美國財政部");
    const entries = xml.split("<entry>").slice(1);
    if(!entries.length) continue;
    const last = entries[entries.length - 1];
    const pick = tag => {
      const m = last.match(new RegExp(`<d:${tag}[^>]*>([^<]*)</d:${tag}>`));
      return m ? parseFloat(m[1]) : NaN;
    };
    const curve = TENORS.map(([tag, years]) => ({years, y:pick(tag)})).filter(p => isFinite(p.y));
    if(!curve.length) continue;
    const date = (last.match(/<d:NEW_DATE[^>]*>([^<T]*)/) || [])[1] ?? null;
    return {date, curve};
  }
  throw new Error("財政部殖利率曲線解析失敗");
}

export function interpolate(curve, T){
  if(T <= curve[0].years) return curve[0].y;
  if(T >= curve.at(-1).years) return curve.at(-1).y;
  for(let i = 0; i < curve.length - 1; i++){
    const a = curve[i], b = curve[i + 1];
    if(T >= a.years && T <= b.years)
      return a.y + (b.y - a.y)*(T - a.years)/(b.years - a.years);
  }
  return curve.at(-1).y;
}

// 財政部報的是半年複利的到期殖利率；Black–Scholes 折現用連續複利
export const toContinuous = parYield => 2*Math.log(1 + parYield/200)*100;

/* ---------- 借用頁面自己的定價模型 ---------- */
// 直接從 index.html 取出 Black–Scholes 區塊來用，確保算出來的數字跟頁面一致；
// 若改抄一份，兩邊遲早會走鐘。
export async function loadPricer(htmlPath){
  const html = await readFile(htmlPath, "utf8");
  const a = html.indexOf("function normCdf");
  const b = html.indexOf("/* ============ 狀態");
  if(a < 0 || b < 0) throw new Error("index.html 找不到 Black–Scholes 區塊");
  return new Function(html.slice(a, b) + "\nreturn {bs, impliedVol};")();
}

/* ---------- 由買賣權平價反推股息殖利率 ---------- */
// C − P = S·e^(−qT) − K·e^(−rT)
export function impliedDividend({callMid, putMid, spot, K, T, r}){
  const disc = (callMid - putMid + K*Math.exp(-r/100*T))/spot;
  const q = disc > 0 ? -Math.log(disc)/T*100 : NaN;
  if(!isFinite(q) || q < -1 || q > 10)             // 價差太寬時會失真，退回不配息
    return {q:0, note:"平價反推結果異常，改用 0"};
  return {q:+q.toFixed(3), note:"由買賣權平價反推"};
}

/* ---------- 一次備妥定價所需的市場參數 ---------- */
export async function loadMarket({symbol, expiry = null, dte = null, minDte = 0, htmlPath, log = () => {}}){
  log(`抓取 ${symbol} 選擇權鏈…`);
  const chain = await fetchChain(symbol);
  const spot = chain.data.current_price;
  if(!(spot > 0)) throw new Error(`現價異常：${spot}`);
  const byExp = groupByExpiry(chain.data.options);

  const picked = pickExpiry(byExp, {expiry, dte, minDte}, todayUtc());
  const T = picked.dte/365;
  const atm = pickAtm(byExp.get(picked.e), spot);

  log("抓取公債殖利率曲線…");
  const {date:curveDate, curve} = await fetchYieldCurve(todayUtc());
  const parYield = interpolate(curve, T);
  const r = toContinuous(parYield);
  if(!(r > -1 && r < 20)) throw new Error(`利率超出合理範圍：${r}%`);

  const {q, note:qNote} = impliedDividend({
    callMid:atm.callQuote.price, putMid:atm.putQuote.price, spot, K:atm.K, T, r
  });

  return {
    chain, byExp, spot, expiry:picked.e, dte:picked.dte, T, atm,
    r:+r.toFixed(3), q, qNote, parYield:+parYield.toFixed(3), curveDate, curve,
    pricer: await loadPricer(htmlPath)
  };
}

/* ---------- 給網頁曝險試算器用的鏈摘要 ---------- */
// 每個到期日各自算利率與股息，每個履約價各自反解 IV——共用單一 IV 會被波動率偏斜帶歪。
// 用陣列而非物件存每一列，省下大量重複的欄位名稱。
export function buildChainSummary(m, {minDte = 1, minOi = 10, sd = 3.5} = {}){
  const {spot, byExp, curve, pricer:{bs, impliedVol}} = m;
  const today = todayUtc();
  const expiries = [];

  for(const {e, dte} of listExpiries(byExp, today)){
    if(dte < minDte) continue;
    const T = dte/365;
    const r = toContinuous(interpolate(curve, T));
    let q = 0, atmIv = 0.25;
    try{
      const atm = pickAtm(byExp.get(e), spot);
      q = impliedDividend({callMid:atm.callQuote.price, putMid:atm.putQuote.price, spot, K:atm.K, T, r}).q;
      atmIv = impliedVol("call", spot, atm.K, T, r/100, q/100, atm.callQuote.price) ?? atmIv;
    }catch{ /* 該到期日湊不出平價，股息以 0 計 */ }

    // 取樣寬度按標準差走：短天期自然收窄、長天期自然放寬，
    // 比固定百分比省得多，又不會把有意義的履約價切掉。
    const halfBand = Math.min(0.70, Math.max(0.12, sd*atmIv*Math.sqrt(T)));
    const loSpot = 1 - halfBand, hiSpot = 1 + halfBand;

    const byK = new Map();
    for(const c of byExp.get(e)){
      if(c.open_interest < minOi) continue;
      if(c.K < spot*loSpot || c.K > spot*hiSpot) continue;
      const qt = quoteOf(c);
      if(!qt || qt.price <= 0) continue;
      const kind = c.cp === "C" ? "call" : "put";
      const iv = impliedVol(kind, spot, c.K, T, r/100, q/100, qt.price);
      if(iv === null) continue;
      const {delta} = bs(kind, spot, c.K, T, r/100, q/100, iv);
      if(Math.abs(delta) < 0.05 || Math.abs(delta) > 0.95) continue;
      if(!byK.has(c.K)) byK.set(c.K, {});
      byK.get(c.K)[c.cp] = [qt.price, +(iv*100).toFixed(2), c.open_interest];
    }
    const rows = [...byK.entries()].sort((a, b) => a[0] - b[0])
      .map(([K, v]) => [K, ...(v.C ?? [0, 0, 0]), ...(v.P ?? [0, 0, 0])]);
    if(rows.length) expiries.push({e, dte, r:+r.toFixed(3), q, rows});
  }

  return {
    asOf: m.chain.timestamp ?? new Date().toISOString(),
    symbol: m.chain.data.symbol ?? m.chain.symbol,
    spot,
    // rows 每列：[履約價, 買權中價, 買權IV%, 買權OI, 賣權中價, 賣權IV%, 賣權OI]
    expiries,
    term: buildIvTerm(m)
  };
}

// 價平 IV 的期間結構：[剩餘天數, IV%]，涵蓋所有到期日（含近月）。
// 頁面拿它當「IV 隨時間變化」的形狀，再平行位移到使用者填的 IV 上。
export function buildIvTerm(m){
  const {spot, byExp, curve, pricer:{impliedVol}} = m;
  const term = [];
  for(const {e, dte} of listExpiries(byExp, todayUtc())){
    if(dte < 1) continue;
    try{
      const atm = pickAtm(byExp.get(e), spot);
      const T = dte/365;
      const r = toContinuous(interpolate(curve, T));
      const {q} = impliedDividend({
        callMid:atm.callQuote.price, putMid:atm.putQuote.price, spot, K:atm.K, T, r
      });
      const iv = impliedVol("call", spot, atm.K, T, r/100, q/100, atm.callQuote.price);
      if(iv && iv > 0.01 && iv < 3) term.push([dte, +(iv*100).toFixed(2)]);
    }catch{ /* 該到期日湊不出平價就跳過 */ }
  }
  return term;
}
