import { daysTo, SOL_ROW } from "./data.js";
import { state, src } from "./state.js";
import { legDte } from "./model.js";
import { strikeStep } from "./strategies.js";

// 內含價值＝現在履約就能拿到的錢；剩下的都是時間價值，到期會歸零
export const intrinsicOf = (leg, S) => Math.max(0, leg.type === "call" ? S - leg.K : leg.K - S);

// 鏈上最接近某個剩餘天數的那一批合約
export const expiryNear = d => {
  const CHAIN = src.chain;
  return CHAIN.expiries?.length
    ? CHAIN.expiries.reduce((a, b) => Math.abs(daysTo(b.e) - d) < Math.abs(daysTo(a.e) - d) ? b : a)
    : null;
};

/* 這個腳位在「它自己的到期日」上、真正報得出價的履約價階梯（由小到大）。
   跨到期日的部位裡，遠腳必須查它自己那一批合約——拿近腳的報價去填 LEAPS，
   權利金會少掉一整年的時間價值。
   有些列只有賣權報價，買權腳位停在那裡會找不到價，所以要逐列過濾。 */
export function quotableStrikes(leg){
  const CHAIN = src.chain;
  if(leg.type === "stock" || !CHAIN.expiries?.length) return [];
  const want = legDte(leg);
  const ex = expiryNear(want);
  if(Math.abs(daysTo(ex.e) - want) > 3) return [];   // 天數對不上就不是同一批合約
  const midCol = leg.type === "call" ? SOL_ROW.cMid : SOL_ROW.pMid;
  const ivCol  = leg.type === "call" ? SOL_ROW.cIv  : SOL_ROW.pIv;
  return ex.rows
    .filter(r => r[midCol] > 0 && r[ivCol] > 0)
    .map(r => ({expiry:ex.e, K:r[SOL_ROW.K], mid:r[midCol], iv:r[ivCol]}))
    .sort((a, b) => a.K - b.K);
}

export function chainQuote(leg){
  const list = quotableStrikes(leg);
  if(!list.length) return null;
  return list.reduce((a, b) => Math.abs(b.K - leg.K) < Math.abs(a.K - leg.K) ? b : a);
}

/* 微調鍵的步進值取「目前履約價附近」的間距，不是整條階梯的中位數。
   TQQQ 的階梯在 42–67.5 之間是 0.5、到了價平的 70 附近卻是 2.5，
   用中位數會讓微調鍵每次只走 0.5，吸附後又回到原點，看起來像壞掉。 */
export function listedStep(leg){
  const list = quotableStrikes(leg);
  if(list.length < 2) return strikeStep(state.S);
  let below = null, above = null;
  for(const x of list){
    if(x.K < leg.K - 1e-9) below = x.K;
    if(x.K > leg.K + 1e-9 && above === null) above = x.K;
  }
  const gaps = [above != null ? above - leg.K : null, below != null ? leg.K - below : null]
    .filter(g => g != null && g > 0);
  return gaps.length ? +Math.min(...gaps).toFixed(4) : strikeStep(state.S);
}

/* 把腳位對齊到掛牌履約價，並帶入該檔的市價與 IV。
   給了 prevK 時會判斷移動方向：若「最接近」的結果就是原本那一檔（階梯間距大於
   微調幅度時必然如此），就改抓該方向上的下一檔，否則微調鍵永遠推不動。 */
export function applyChainQuote(leg, prevK){
  const list = quotableStrikes(leg);
  if(!list.length) return false;
  let target = list.reduce((a, b) => Math.abs(b.K - leg.K) < Math.abs(a.K - leg.K) ? b : a);
  if(prevK != null && Math.abs(leg.K - prevK) > 1e-9 && Math.abs(target.K - prevK) < 1e-9){
    const up = leg.K > prevK;
    const next = up ? list.find(x => x.K > prevK + 1e-9)
                    : [...list].reverse().find(x => x.K < prevK - 1e-9);
    if(next) target = next;
  }
  leg.K = target.K;
  leg.premium = target.mid;
  leg.iv = target.iv;
  return true;
}

/* ============ 到期日選單 ============ */
// 換到期日不只是換天數：利率、股息、每個履約價的報價與 IV 都是該到期日專屬的，
// 沿用舊值會讓理論價整條偏掉，所以一併換掉。
export function repriceLegsFrom(ex){
  const missed = [];
  for(const leg of state.legs){
    if(leg.type === "stock") continue;
    // 每一腳從自己的到期日取價。近腳走剛選的 ex，遠腳走鏈上它自己那一批——
    // 拿近月的報價去填 LEAPS 腳位，權利金會少掉一整年的時間價值。
    const from = expiryNear(legDte(leg)) ?? ex;
    const row = from.rows.find(x => x[SOL_ROW.K] === leg.K);
    const mid = row?.[leg.type === "call" ? SOL_ROW.cMid : SOL_ROW.pMid];
    const iv  = row?.[leg.type === "call" ? SOL_ROW.cIv  : SOL_ROW.pIv];
    if(mid > 0 && iv > 0){ leg.premium = mid; leg.iv = iv; }
    else missed.push(leg.K);
  }
  return missed;
}
