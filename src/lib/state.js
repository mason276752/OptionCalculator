import { reactive } from "vue";
import { MARKETS, CHAINS, SYMBOLS, daysTo } from "./data.js";

/* ============ 狀態 ============ */

/* 目前選定的標的；src.market／src.chain 是它在兩份資料裡的切片，切換標的時一起換掉。
   原本是兩個 module 層級的 let（MARKET／CHAIN）；包進 reactive 容器，
   換標的時依賴它們的 computed 才會重新求值。用到的地方一律在函式開頭
   取一次區域別名（const CHAIN = src.chain），函式本體維持原樣。 */
const SYM0 = SYMBOLS.includes("QQQ") ? "QQQ" : SYMBOLS[0];
export const src = reactive({
  market: MARKETS[SYM0],
  chain: CHAINS[SYM0] ?? {expiries:[], term:[]}
});

const MARKET0 = MARKETS[SYM0];
const DTE0 = MARKET0.expiry ? daysTo(MARKET0.expiry) : MARKET0.dte;

/* 一套「組合」= 一組腳位 ＋ 它的範本堆疊 ＋ 圖上的身分（名字、顏色、顯不顯示）。
   多套組合共用同一組市場參數與同一個模擬時點——不共用就沒有比較的基準，
   兩條曲線各自站在不同的現價或不同的剩餘天數上，疊在一張圖裡毫無意義。 */
const raw = {
  S:MARKET0.spot, dte:DTE0, iv:MARKET0.iv, mult:100, r:MARKET0.r, q:MARKET0.q,
  symbol:MARKET0.symbol, rangePct:35, tRem:DTE0, ivTerm:true, ivSkew:"strike",
  combos:[{
    id:1, name:"組合 A", c:0, on:true,
    // 已套用的範本堆疊：[{k:範本代號, g:群組編號}]。腳位上的 g 指回這裡，
    // 才能在疊加了三個範本之後，還能單獨把其中一個拆掉。
    presets:[{k:"long-call", g:1}],
    legs:[{id:1, type:"call", side:1, K:MARKET0.strike, premium:MARKET0.callMid, qty:1, iv:MARKET0.iv, g:1}]
  }],
  active:1
};

let legId = 2, groupId = 2, comboId = 2;
export const nextLegId = () => legId++;
export const nextGroupId = () => groupId++;
export const nextComboId = () => comboId++;

/* 整份計算與大部分的畫面程式碼都只認得 state.legs／state.presets。
   把這兩個屬性接成存取器、指向「目前求值中的組合」，就能用同一套數學
   把任何一套組合再算一遍——多曲線圖與多條敏感度小圖就是這樣來的，
   底下的 analyze()／pnlAt()／greeks() 一行都不用改。
   兩者刻意是不可列舉的，JSON.stringify(state) 存的是 combos 而不是它們的複本。 */
let EVAL = null;
export const activeCombo = () => state.combos.find(c => c.id === state.active) || state.combos[0];
const curCombo = () => EVAL || activeCombo();
export const visibleCombos = () => state.combos.filter(c => c.on !== false);
// 圖表與敏感度要畫的組合：全部關掉時退回目前選中的那一套，免得畫面整片空白
export const shownCombos = () => visibleCombos().length ? visibleCombos() : [activeCombo()];
// 只有一套時維持原本的紅綠漲跌配色；一旦不只一套，線條就得改用分類色來認身分
export const isMulti = () => state.combos.length > 1;
export function withCombo(c, fn){
  const prev = EVAL;
  EVAL = c;
  try{ return fn(); }finally{ EVAL = prev; }
}
for(const key of ["legs", "presets"]){
  Object.defineProperty(raw, key, {
    get(){ const c = curCombo(); return c ? (c[key] ||= []) : []; },
    set(v){ const c = curCombo(); if(c) c[key] = v; }
  });
}

export const state = reactive(raw);

/* 顏色只有四階。同一個色相要靠深淺分辨，能拉開的明度就那麼多——
   四階已經佔滿「最淡的還看得見、最深的還看得出是紅是綠是藍」之間的全部空間，
   再切下去就是兩條線同一個顏色。 */
export const SERIES_N = 4;
export const COMBO_LETTERS = "ABCD";
const slotOf = c => ((c.c ?? 0) % SERIES_N) + 1;
export const comboPos = c => `var(--pos${slotOf(c)})`;      // 到期線：上漲側
export const comboNeg = c => `var(--neg${slotOf(c)})`;      // 到期線：下跌側
export const comboAcc = c => `var(--acc${slotOf(c)})`;      // T+n 線，兼作這一套的身分色
// 顏色跟著組合本身走，不跟著它在清單裡的名次：刪掉中間一套，其餘的顏色不會重新洗牌
export function freeColorSlot(){
  const used = new Set(state.combos.map(c => c.c));
  for(let i = 0; i < SERIES_N; i++) if(!used.has(i)) return i;
  return state.combos.length % SERIES_N;
}
export function nextComboName(){
  for(const ch of COMBO_LETTERS){
    const n = "組合 " + ch;
    if(!state.combos.some(c => c.name === n)) return n;
  }
  return "組合 " + (state.combos.length + 1);
}

/* ---- 設定的存放：瀏覽器本機 ----
   每次改動就整份寫回 localStorage，關掉分頁再開回來還在。
   舊版是把設定編碼進網址雜湊，所以帶著那種連結進來仍然要認得，而且優先於本機存的
   （使用者的意圖是「開這個連結」）；讀完就把雜湊從網址上抹掉，之後一律走本機。 */
const STORE_KEY = "leapscalc:state";
export function saveState(){
  try{ localStorage.setItem(STORE_KEY, JSON.stringify(state)); }catch(e){/* 無痕模式等情況：存不了就算了 */}
}
export function loadState(){
  try{
    let raw = null, fromHash = false;
    if(location.hash && location.hash.length > 1){
      raw = decodeURIComponent(escape(atob(location.hash.slice(1))));
      fromHash = true;
    }else{
      try{ raw = localStorage.getItem(STORE_KEY); }catch(e){ raw = null; }
    }
    if(!raw) return;
    const o = JSON.parse(raw);
    if(fromHash) history.replaceState(null, "", location.pathname + location.search);
    if(!o) return;
    // 舊連結只存了一個部位（更早的版本連範本都只是一個字串）；包成第一套組合
    if(!Array.isArray(o.combos)){
      if(!Array.isArray(o.legs) || !o.legs.length) return;
      let presets = Array.isArray(o.presets) ? o.presets : [];
      if(typeof o.preset === "string"){
        presets = o.preset ? [{k:o.preset, g:1}] : [];
        if(o.preset) for(const l of o.legs) l.g = 1;
      }
      o.combos = [{id:1, name:"組合 A", c:0, on:true, legs:o.legs, presets}];
      o.active = 1;
    }
    // 這三個鍵不能留：legs／presets 是存取器，assign 進去會反過來蓋掉組合的內容
    delete o.legs; delete o.presets; delete o.preset;
    o.combos = o.combos.filter(c => c && Array.isArray(c.legs));
    if(!o.combos.length) return;
    o.combos.forEach((c, i) => {
      c.id = c.id ?? i + 1;
      c.name = c.name || ("組合 " + (COMBO_LETTERS[i] || i + 1));
      c.c = c.c ?? i % SERIES_N;
      c.on = c.on !== false;
      if(!Array.isArray(c.presets)) c.presets = [];
    });
    Object.assign(state, o);
    if(!state.combos.some(c => c.id === state.active)) state.active = state.combos[0].id;
    const all = state.combos.flatMap(c => c.legs);
    legId = Math.max(0, ...all.map(l => l.id || 0)) + 1;
    groupId = Math.max(0, ...state.combos.flatMap(c => c.presets.map(p => p?.g || 0))) + 1;
    comboId = Math.max(0, ...state.combos.map(c => c.id)) + 1;
  }catch(e){/* 壞掉的連結就用預設值 */}
}
