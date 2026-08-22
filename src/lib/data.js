/* ============ 市場資料 ============
   過去這兩份資料是由 fetch-market.mjs 直接嵌回 index.html 的標記區塊；
   改成 Vue 專案之後頁面不再是單一自足檔案，直接 import 同一份 JSON 即可，
   打包時會變成模組常數，執行期不需要再發一次網路請求。 */
import marketJson from "../../market.json";
import chainJson from "../../chain.json";

// 頁面只需要載入預設部位的那幾個欄位（過去嵌進 HTML 的精簡版就是這一組）
const INLINE = ["asOf", "symbol", "spot", "expiry", "dte", "strike", "iv", "r", "q", "callMid"];

export const MARKETS = Object.fromEntries(
  Object.entries(marketJson.symbols).map(([sym, d]) =>
    [sym, Object.fromEntries(INLINE.map(k => [k, d[k]]))]));

export const CHAINS = chainJson;
export const SYMBOLS = Object.keys(MARKETS);

// 距到期天數以「到期日 − 今天」重算，檔案放久了也不會失準（以整日計，與抓取腳本一致）
export function daysTo(iso){
  const n = new Date();
  const midnight = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.max(0, Math.round((new Date(iso + "T00:00:00Z") - midnight)/86400000));
}

// 鏈摘要每一列的欄位順序
export const SOL_ROW = {K:0, cMid:1, cIv:2, cOi:3, pMid:4, pIv:5, pOi:6};

export const LABEL = {call:"買權 Call", put:"賣權 Put", stock:"標的 現股"};
