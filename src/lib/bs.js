/* ============ Black–Scholes ============ */
// market-lib.mjs 會直接 import 這個模組，確保腳本算出來的數字跟頁面一致；
// 若改抄一份，兩邊遲早會走鐘。

export function normCdf(x){
  if(x < 0) return 1 - normCdf(-x);
  const b1=.319381530,b2=-.356563782,b3=1.781477937,b4=-1.821255978,b5=1.330274429,p=.2316419,c=.39894228;
  const t = 1/(1+p*x);
  return 1 - c*Math.exp(-x*x/2)*t*(t*(t*(t*(t*b5+b4)+b3)+b2)+b1);
}
export function normPdf(x){ return 0.3989422804014327*Math.exp(-x*x/2); }

// T 以年為單位；v、r、q 以小數表示
export function bs(type, S, K, T, r, q, v){
  const isCall = type === "call";
  if(T <= 0 || v <= 0 || S <= 0){
    const intrinsic = Math.max(0, isCall ? S-K : K-S);
    const inMoney = isCall ? S > K : S < K;
    return {price:intrinsic, delta:inMoney ? (isCall?1:-1) : 0, gamma:0, theta:0, vega:0, rho:0};
  }
  const sq = v*Math.sqrt(T);
  const d1 = (Math.log(S/K) + (r - q + v*v/2)*T)/sq;
  const d2 = d1 - sq;
  const dfq = Math.exp(-q*T), dfr = Math.exp(-r*T);
  const Nd1 = normCdf(d1), Nd2 = normCdf(d2), nd1 = normPdf(d1);
  const price = isCall
    ? S*dfq*Nd1 - K*dfr*Nd2
    : K*dfr*normCdf(-d2) - S*dfq*normCdf(-d1);
  const delta = isCall ? dfq*Nd1 : dfq*(Nd1 - 1);
  const gamma = dfq*nd1/(S*sq);
  const vega  = S*dfq*nd1*Math.sqrt(T)/100;                 // 每 1% 波動率
  const thetaY = isCall
    ? -S*dfq*nd1*v/(2*Math.sqrt(T)) - r*K*dfr*Nd2 + q*S*dfq*Nd1
    : -S*dfq*nd1*v/(2*Math.sqrt(T)) + r*K*dfr*normCdf(-d2) - q*S*dfq*normCdf(-d1);
  const rho = (isCall ? K*T*dfr*Nd2 : -K*T*dfr*normCdf(-d2))/100;
  return {price, delta, gamma, vega, theta:thetaY/365, rho};
}

// 由權利金反推隱含波動率（二分法）
export function impliedVol(type, S, K, T, r, q, target){
  const intrinsic = Math.max(0, type==="call" ? S*Math.exp(-q*T)-K*Math.exp(-r*T) : K*Math.exp(-r*T)-S*Math.exp(-q*T));
  if(!(target > intrinsic + 1e-9) || T <= 0) return null;
  let lo = 1e-4, hi = 5;
  if(bs(type,S,K,T,r,q,hi).price < target) return null;
  for(let i=0;i<80;i++){
    const mid = (lo+hi)/2;
    if(bs(type,S,K,T,r,q,mid).price < target) lo = mid; else hi = mid;
  }
  return (lo+hi)/2;
}
