import { bs } from "./bs.js";
import { daysTo, SOL_ROW } from "./data.js";
import { state, src } from "./state.js";
import { yearsLeft } from "./model.js";

/* ============ 曝險試算 ============ */
// 每個履約價都湊得出目標曝險（多買幾口就是了），差別在成本、耗損與歸零風險。
// 因此這裡不挑「唯一解」，而是把整條光譜列出來，標出三個代表點。
// 每個履約價用的是它自己反解出的 IV，已反映波動率偏斜。
export const SOL_DELTA_MIN = 0.20, SOL_DELTA_MAX = 0.85, SOL_MAX_ROWS = 20;
// 口數只能是整數，深價內一口的曝險就很大，目標太小時會被迫超標。
// 超過這個相對誤差就視為打不中目標，不列入代表點。
export const SOL_FIT = 0.15;

/* 參數過去是直接從四個 DOM 欄位讀的；現在由呼叫端傳進同樣那四個值
   （SolverPanel 的 reactive 表單狀態），計算本身完全沒有變。 */
export function solveExposure({expiry, target:targetRaw, type:cp, budget:budgetRaw}){
  const CHAIN = src.chain;
  const ex = CHAIN.expiries.find(x => x.e === expiry);
  if(!ex) return {rows:[]};
  const target = Math.abs(+targetRaw) || 0;
  const budget = +budgetRaw > 0 ? +budgetRaw : Infinity;
  if(!target) return {rows:[], ex};

  const spot = CHAIN.spot, dte = daysTo(ex.e), T = yearsLeft(dte), mult = state.mult;
  const out = [];
  for(const row of ex.rows){
    const mid = row[cp === "call" ? SOL_ROW.cMid : SOL_ROW.pMid];
    const iv  = row[cp === "call" ? SOL_ROW.cIv  : SOL_ROW.pIv];
    const oi  = row[cp === "call" ? SOL_ROW.cOi  : SOL_ROW.pOi];
    if(!(mid > 0) || !(iv > 0)) continue;
    const K = row[SOL_ROW.K];
    const g = bs(cp, spot, K, T, ex.r/100, ex.q/100, iv/100);
    const absDelta = Math.abs(g.delta);
    if(absDelta < SOL_DELTA_MIN || absDelta > SOL_DELTA_MAX) continue;
    const perContract = g.delta*spot*mult;
    if(Math.abs(perContract) < 1e-6) continue;
    const qty = Math.max(1, Math.round(target/Math.abs(perContract)));
    const cost = mid*mult*qty;
    if(cost > budget) continue;
    const theta = g.theta*mult*qty;
    const exposure = perContract*qty;
    const dev = (Math.abs(exposure) - target)/target;   // 帶正負號的偏離幅度
    // 抱到到期會被時間吃光的總額＝現在付的時間價值（＝合約價扣掉內含價值）。
    // 每日耗損只看得到當下的速度，這欄才是這個履約價的總帳單。
    const intrinsic = Math.max(0, cp === "call" ? spot - K : K - spot);
    const decay = -Math.max(0, mid - intrinsic)*mult*qty;
    out.push({
      K, mid, iv, oi, qty, delta:g.delta,
      exposure, cost,
      lev:Math.abs(exposure)/cost,
      theta, carry:Math.abs(theta)/cost*100,
      decay, decayPct:Math.abs(decay)/cost*100,
      dev, err:Math.abs(dev)
    });
  }
  return {rows:out, ex, dte, spot, cp, target};
}
