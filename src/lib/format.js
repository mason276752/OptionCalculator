/* ============ 格式化 ============ */

export const nf = (n, d) => n.toLocaleString("zh-TW", {minimumFractionDigits:d, maximumFractionDigits:d});

export function money(n){
  if(!isFinite(n)) return n > 0 ? "無上限" : "無下限";
  const a = Math.abs(n);
  if(a < 0.005) return "0";
  return (n < 0 ? "−" : "") + nf(a, a >= 100 ? 0 : 2);
}
export function signedMoney(n){ return (isFinite(n) && n > 0 ? "+" : "") + money(n); }
export function price(n){ return nf(n, Math.abs(n) >= 1000 ? 1 : 2); }
export const cls = n => n > 1e-9 ? "pos" : n < -1e-9 ? "neg" : "";

export function dateAfter(days){
  const d = new Date(Date.now() + days*86400000);
  return d.getFullYear() + "/" + String(d.getMonth()+1).padStart(2,"0")
       + "/" + String(d.getDate()).padStart(2,"0");
}
/* 腳位到期日的標籤。落差為零時明講「近腳」——圖上那條「到期」線畫的就是它到期的那天，
   看到「比近腳晚 N 天」才知道這一腳在那個時點還活著。 */
export const expiryLabel = (d, gap) =>
  `（${dateAfter(d)}${gap > 0 ? `　比近腳晚 ${gap} 天` : "　近腳"}）`;

/* 舊版每個 render 函式都在組 HTML 字串，所以到處要手動 esc()；
   改成模板之後插值由 Vue 自己跳脫，那個工具函式就不需要了。 */
