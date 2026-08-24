import { MARKETS, CHAINS, daysTo } from "./data.js";
import {
  state, src, nextLegId, nextGroupId, nextComboId,
  freeColorSlot, nextComboName, SERIES_N, setSpotAnchor
} from "./state.js";
import { bs } from "./bs.js";
import { clearSmileCache, yearsLeft } from "./model.js";
import { roundStrike } from "./strategies.js";

/* 數字欄位共用的輸入處理：填到一半（空字串、只有一個負號）時 parseFloat 會是 NaN，
   那時什麼都不做——把值硬寫回去會在使用者還在打字時就搶走欄位。 */
export function onNum(ev, apply){
  const v = parseFloat(ev.target.value);
  if(!isFinite(v)) return;
  apply(v);
}

/* 「重新指定現價」——手動輸入或由曝險試算帶入時走這條，圖表區間跟著重新置中。
   滑桿橫移則只改 state.S，不動錨點（見 state.js 的 spotAnchor）。 */
export function setSpot(v){
  state.S = v;
  setSpotAnchor(v);
}

// 新組合先給一口價平買權當起點；空組合會讓摘要的最大獲利／虧損全部是 0，讀不出東西
export function addCombo(from){
  if(state.combos.length >= SERIES_N) return;
  const g = nextGroupId();
  const K = +roundStrike(state.S).toFixed(2);
  const c = {
    id:nextComboId(), name:nextComboName(), c:freeColorSlot(), on:true,
    legs: from
      ? from.legs.map(l => ({...l, id:nextLegId()}))
      : [{id:nextLegId(), type:"call", side:1, K, qty:1, iv:state.iv,
          premium:+bs("call", state.S, K, yearsLeft(state.dte), state.r/100, state.q/100, state.iv/100).price.toFixed(2), g}],
    // 複製時範本堆疊要跟著複製一份：群組編號在組合內部才有意義，沿用同一組就對得起來
    presets: from ? from.presets.map(p => ({...p})) : [{k:"long-call", g}]
  };
  state.combos.push(c);
  state.active = c.id;
}

/* ============ 標的切換 ============ */
// 換標的等於換一整組市場資料：現價、到期日清單、利率、股息、偏斜曲線全都不同，
// 沿用舊部位的履約價與權利金毫無意義，所以預設重建成該標的的價平部位。
export function applySymbol(sym, {reset = true} = {}){
  if(!MARKETS[sym]) return;
  const MARKET = MARKETS[sym];
  state.symbol = sym;
  src.market = MARKET;
  src.chain = CHAINS[sym] ?? {expiries:[], term:[]};
  clearSmileCache();
  if(reset){
    const dte = MARKET.expiry ? daysTo(MARKET.expiry) : MARKET.dte;
    Object.assign(state, {S:MARKET.spot, dte, tRem:dte, iv:MARKET.iv, r:MARKET.r, q:MARKET.q});
    const g = nextGroupId();
    // 換標的時所有組合都作廢（履約價與權利金全是舊標的的），退回單一套價平買權
    state.combos = [{
      id:nextComboId(), name:"組合 A", c:0, on:true,
      legs:[{id:nextLegId(), type:"call", side:1,
        K:MARKET.strike, premium:MARKET.callMid, qty:1, iv:MARKET.iv, g}],
      presets:[{k:"long-call", g}]
    }];
    state.active = state.combos[0].id;
  }
  // 換標的（或載入既有設定）之後，圖表區間重新以現價置中
  setSpotAnchor(state.S);
}
