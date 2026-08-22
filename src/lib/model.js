import { bs } from "./bs.js";
import { daysTo, SOL_ROW } from "./data.js";
import { money } from "./format.js";
import { state, src } from "./state.js";

/* ============ 部位計算 ============ */
export const yearsLeft = d => Math.max(0, d)/365;
export const legMult = leg => leg.type === "stock" ? 1 : state.mult;

/* ---- 每一腳自己的到期日 ----
   state.dte 是「部位時鐘」，定義成最近的那一腳（近腳）；個別腳位可以更遠，
   兩者的差額就是日曆／對角價差（含 PMCC）的跨月結構。腳位沒填 dte 就沿用
   state.dte，所以同一到期日的部位算出來與過去完全一樣。

   時間只有一把尺：部位時鐘從 state.dte 走到 d，經過的天數是 state.dte − d，
   每一腳就各自老掉那麼多天。因此「到期損益」畫的是近腳到期的那一天，
   遠腳在那個時點還活著、還帶著時間價值——這正是 PMCC 要看的那張圖。

   個別腳位不能早於部位時鐘：那會讓它在圖上的參考時點之前就結算，
   而結算價取決於它到期當下的標的價（路徑相依），單一張損益圖表達不了。
   所以這裡在讀取時就夾住，使用者調低全域天數時原本填的值仍然保留。 */
export const legDte = leg =>
  leg.type === "stock" ? state.dte : Math.max(state.dte, leg.dte ?? state.dte);
// 部位時鐘剩 d 天時，這一腳自己還剩幾天
export const legRem = (leg, d) => Math.max(0, legDte(leg) - state.dte + d);
// 有沒有跨到期日的腳位——決定到期損益是分段線性還是彎的
export const isDiagonal = () => state.legs.some(l => legDte(l) > state.dte + 1e-9);

/* ---- IV 隨剩餘天數變化 ----
   市場對不同到期日開的 IV 本來就不同（期間結構）。CHAIN.term 是今天觀察到的
   價平 IV 對剩餘天數的曲線；把它平行位移到使用者填的 IV 上，就得到
   「這口合約隨著時間老去，IV 大概會走到哪」的基準情境。
   位移量在部位自己的到期天數處為零，所以填進去的 IV 永遠原封不動地被採用。
   注意：這是「期間結構原地不動」的假設，不是預測；真正的 IV 每天都在跳。 */
export function ivTermAt(d){
  const CHAIN = src.chain;
  const t = CHAIN.term;
  if(!t?.length) return null;
  if(d <= t[0][0]) return t[0][1];
  if(d >= t[t.length-1][0]) return t[t.length-1][1];
  for(let i = 0; i < t.length - 1; i++){
    const [d0, v0] = t[i], [d1, v1] = t[i+1];
    if(d >= d0 && d <= d1){
      // 內插的是「總變異數」（IV²×天數）而不是 IV 本身——直接內插 IV
      // 會在到期日之間生出日曆價差套利，變異數線性才是無套利的慣例做法。
      const w0 = v0*v0*d0, w1 = v1*v1*d1;
      return Math.sqrt((w0 + (w1 - w0)*(d - d0)/(d1 - d0))/d);
    }
  }
  return t[t.length-1][1];
}

/* 期間結構的位移量：從「錨點到期日」看到「剩 d 天」要調整幾個百分點。
   錨點預設是部位時鐘，但跨到期日的部位裡每一腳都得錨在自己的到期日上——
   近月與 LEAPS 的 IV 水準本來就不同，共用一個錨點會把整條期間結構壓平，
   PMCC 賺的價差有一部分就來自這個差距。 */
export function ivShift(d, anchorDte = state.dte){
  if(!state.ivTerm) return 0;
  const here = ivTermAt(d), anchor = ivTermAt(anchorDte);
  return here == null || anchor == null ? 0 : here - anchor;
}

/* ---- IV 隨標的價格變化（偏斜慣例） ----
   同一個到期日、不同履約價的 IV 本來就不同（偏斜）。標的移動時該怎麼看待這條曲線，
   沒有唯一正解，業界有兩種慣例：
     固定履約價 sticky strike ── 曲面在 (履約價, 到期) 座標上不動，某個履約價的 IV 就是今天報的那個。
                                 與「沿期間結構滑落」是同一個假設的兩面，所以設為預設。
     固定價性 sticky moneyness ─ 曲面釘在價性上，標的一跌，整條偏斜跟著平移，
                                 原本價平的履約價變成價內、IV 也跟著換位置取值。
   兩者都用平行位移實作：市場資料只提供形狀，水準永遠是使用者填的那個值。 */
const SMILE_CACHE = new Map();
export const clearSmileCache = () => SMILE_CACHE.clear();

export function smileFor(leg){
  const CHAIN = src.chain;
  if(!CHAIN.expiries?.length) return null;
  // 偏斜形狀取這一腳自己的到期日：近月的微笑比 LEAPS 陡得多
  const want = legDte(leg);
  const ex = CHAIN.expiries.reduce((a, b) =>
    Math.abs(daysTo(b.e) - want) < Math.abs(daysTo(a.e) - want) ? b : a);
  if(SMILE_CACHE.has(ex.e)) return SMILE_CACHE.get(ex.e);
  // 只取價外報價：現價以下用賣權、以上用買權。價內合約買賣價差寬、中價不可信，
  // 反解出的 IV 會歪掉（深價內買權常算出 30%+，那是流動性假象不是市場預期）。
  // 買賣權平價保證同一履約價的 IV 相同，所以拼起來就是一條完整的偏斜曲線。
  const pts = ex.rows
    .map(r => {
      const K = r[SOL_ROW.K];
      const iv = K < CHAIN.spot ? r[SOL_ROW.pIv] : r[SOL_ROW.cIv];
      return K > 0 && iv > 0 ? [Math.log(K/CHAIN.spot), iv] : null;
    })
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0]);
  const smile = pts.length >= 3 ? pts : null;
  SMILE_CACHE.set(ex.e, smile);
  return smile;
}

export function smileAt(smile, x){
  if(x <= smile[0][0]) return smile[0][1];
  if(x >= smile[smile.length-1][0]) return smile[smile.length-1][1];
  for(let i = 0; i < smile.length - 1; i++){
    const [x0, v0] = smile[i], [x1, v1] = smile[i+1];
    if(x >= x0 && x <= x1) return v0 + (v1 - v0)*(x - x0)/(x1 - x0);
  }
  return smile[smile.length-1][1];
}

export function skewShift(leg, S){
  if(state.ivSkew !== "moneyness" || leg.type === "stock") return 0;
  if(!(S > 0) || !(state.S > 0) || Math.abs(S - state.S) < 1e-9) return 0;
  const smile = smileFor(leg);
  if(!smile) return 0;
  return smileAt(smile, Math.log(leg.K/S)) - smileAt(smile, Math.log(leg.K/state.S));
}

// d 一律是「部位時鐘」的剩餘天數；換算成這一腳自己的剩餘天數才去查期間結構
export function legIv(leg, d, S = state.S){
  return Math.max(0.1,
    (leg.iv ?? state.iv) + ivShift(legRem(leg, d), legDte(leg)) + skewShift(leg, S));
}

/* 單一腳位在標的價 S、部位時鐘剩 d 天時的理論價。

   取內含價值當下界，是因為 bs() 是歐式公式而美股選擇權是美式的：隨時可以履約，
   市價就不會低於內含價值。深價內時歐式公式確實會算得比內含價值低（配息標的的
   買權、以及深價內賣權都會），平常看不出來，但跨到期日的部位會被它坑：
   標的暴漲時近腳的買權被指派、要付 S − K，遠腳卻被歐式公式評成「跟不上」，
   於是憑空長出一條其實不存在的無上限虧損。實務上你會把遠腳履約，這裡就是那件事。 */
export function legValue(leg, S, d){
  const T = yearsLeft(legRem(leg, d));
  const iv0 = Math.max(0, leg.type === "call" ? S - leg.K : leg.K - S);
  if(T <= 0) return iv0;
  return Math.max(iv0,
    bs(leg.type, S, leg.K, T, state.r/100, state.q/100, legIv(leg, d, S)/100).price);
}

// 單一腳位在標的價 S、部位時鐘剩 d 天時的損益
export function legPnl(leg, S, d){
  const n = leg.side * leg.qty * legMult(leg);
  if(leg.type === "stock") return n * (S - leg.premium);
  return n * (legValue(leg, S, d) - leg.premium);
}
export const pnlAt = (S, d) => state.legs.reduce((a, leg) => a + legPnl(leg, S, d), 0);
export const expiryPnl = S => pnlAt(S, 0);

/* 跨到期日時的取樣格。曲線是彎的，沒有「轉折只在履約價上」這回事，只能掃。
   等距鋪滿全區間之外，在現價與各履約價附近再加密——彎得最厲害的就是那幾段，
   PMCC 的最大獲利也剛好落在近腳履約價旁邊。 */
function curveNodes(strikes, far, probe){
  const set = new Set([0, far, probe, state.S, ...strikes]);
  const N = 400;
  for(let i = 1; i < N; i++) set.add(far*i/N);
  for(const c of [state.S, ...strikes])
    for(let k = -24; k <= 24; k++){
      const v = c*(1 + 0.005*k);
      if(v > 0 && v < far) set.add(v);
    }
  // far 之外曲線還會繼續緩緩變化，一路粗掃到線性區為止，免得極值藏在取樣範圍外
  for(let i = 1; i < 60; i++) set.add(far + (probe - far)*i/60);
  return [...set].sort((a, b) => a - b);
}

/* 判斷損益會不會隨標的無限發散，斜率要量在「每一腳都已經退化成線性」的地方。

   同月部位越過最高履約價就線性了，量在哪都一樣。跨到期日就不是：時鐘歸零時
   遠腳還有 T 年，它要到極深價內才退化，而那有兩道門檻——
     ・價平附近的曲率要到 K·e^{8σ√T} 才衰乾淨；
     ・有股息時，內含價值要到 S* = K(1−e^{−rT})/(1−e^{−qT}) 之後才追過 BS，
       斜率也是在那之後才收斂成整數。
   兩道都跨過去才量得準。量得不夠遠，一段每 1 元只緩緩掉幾毛的曲線就會被讀成
   無限虧損——PMCC 正是這樣被算出一條根本不存在的無底虧損。 */
function linearProbe(){
  let probe = state.S*10;
  for(const leg of state.legs){
    if(leg.type === "stock") continue;
    const T = yearsLeft(legRem(leg, 0));
    if(T <= 0){ probe = Math.max(probe, leg.K*10); continue; }
    probe = Math.max(probe, leg.K*Math.exp(8*(legIv(leg, 0)/100)*Math.sqrt(T)));
    const rT = state.r/100*T, qT = state.q/100*T;
    if(qT > 1e-9)
      probe = Math.max(probe, 3*leg.K*(1 - Math.exp(-rT))/(1 - Math.exp(-qT)));
  }
  return Math.min(Math.max(probe, 10), 1e9);   // 再遠下去浮點數的有效位數就不夠了
}

/* 三分法：粗掃只會落在取樣點上，真正的極值在相鄰兩點之間。
   dir = 1 找極大、−1 找極小；在 [左鄰, 右鄰] 這個小區間裡曲線是單峰的。 */
function refineExtreme(nodes, i, dir){
  let a = nodes[Math.max(0, i-1)], b = nodes[Math.min(nodes.length-1, i+1)];
  for(let k = 0; k < 60 && b - a > 1e-7; k++){
    const m1 = a + (b-a)/3, m2 = b - (b-a)/3;
    if(dir*expiryPnl(m1) < dir*expiryPnl(m2)) a = m1; else b = m2;
  }
  return expiryPnl((a+b)/2);
}

// 二分法求兩平點：已知損益在 [a, b] 之間變號
function bisectZero(a, b){
  let fa = expiryPnl(a);
  for(let k = 0; k < 60 && b - a > 1e-9; k++){
    const m = (a+b)/2, fm = expiryPnl(m);
    if(fm === 0) return m;
    if((fa < 0) === (fm < 0)){ a = m; fa = fm; } else b = m;
  }
  return (a+b)/2;
}

/* 腳位同一天到期時，到期損益是分段線性的：轉折只會落在履約價上，
   極值與兩平點都能精確求解。跨到期日就不成立了——部位時鐘歸零時遠腳還活著，
   它那段是 Black–Scholes 曲面而不是折線，改走數值解。 */
export function analyze(){
  const strikes = [...new Set(state.legs.filter(l => l.type !== "stock").map(l => l.K))].sort((a,b)=>a-b);
  const far = Math.max(state.S*3, (strikes[strikes.length-1] || state.S)*2 + state.S, 10);
  const diagonal = isDiagonal();
  const probe = linearProbe();
  const nodes = diagonal ? curveNodes(strikes, far, probe) : [0, ...strikes, far];
  const vals = nodes.map(expiryPnl);

  const slopeRight = (expiryPnl(probe) - expiryPnl(probe*0.99))/(probe*0.01);
  // 斜率的判斷門檻要跟著部位大小走：一口買權的末端斜率就是一個乘數，
  // 用固定的絕對值當門檻，在大部位上會把浮點誤差讀成真的發散
  const scale = state.legs.reduce((a, l) => a + Math.abs(l.qty)*legMult(l), 0) || 1;
  const flat = Math.abs(slopeRight) <= scale*1e-6;
  const outer = nodes[nodes.length-1];

  let maxProfit = -Infinity, maxLoss = Infinity, iHi = -1, iLo = -1;
  for(let i=0;i<nodes.length;i++){
    if(nodes[i] > outer - 1e-9 && !flat) continue;   // 端點值不代表極值
    if(vals[i] > maxProfit){ maxProfit = vals[i]; iHi = i; }
    if(vals[i] < maxLoss){ maxLoss = vals[i]; iLo = i; }
  }
  if(diagonal){
    if(iHi >= 0) maxProfit = Math.max(maxProfit, refineExtreme(nodes, iHi, 1));
    if(iLo >= 0) maxLoss   = Math.min(maxLoss,   refineExtreme(nodes, iLo, -1));
  }
  const upUnbounded   = !flat && slopeRight > 0;
  const downUnbounded = !flat && slopeRight < 0;
  if(upUnbounded) maxProfit = Infinity;
  if(downUnbounded) maxLoss = -Infinity;

  const breakevens = [];
  for(let i=0;i<nodes.length-1;i++){
    const a = vals[i], b = vals[i+1];
    if(a === 0) breakevens.push(nodes[i]);
    else if(a*b < 0) breakevens.push(diagonal
      ? bisectZero(nodes[i], nodes[i+1])
      : nodes[i] + (nodes[i+1]-nodes[i])*(-a)/(b-a));
  }
  if(vals[vals.length-1] === 0) breakevens.push(nodes[nodes.length-1]);

  const netPremium = state.legs
    .filter(l => l.type !== "stock")
    .reduce((a,l) => a - l.side * l.qty * state.mult * l.premium, 0); // 正 = 淨收取
  const stockCost = state.legs
    .filter(l => l.type === "stock")
    .reduce((a,l) => a + l.side * l.qty * l.premium, 0);

  // 數值解出來的根可能成雙成對地擠在一起（曲線只是輕輕擦過零軸），
  // 差距小於現價的萬分之一就視為同一個點，免得摘要列出兩個看起來一樣的數字
  const uniq = [...new Set(breakevens.map(b => +b.toFixed(4)))].sort((a,b)=>a-b)
    .filter((b, i, arr) => i === 0 || b - arr[i-1] > state.S*1e-4);

  return {maxProfit, maxLoss, breakevens:uniq, netPremium, stockCost, strikes, diagonal};
}

/* 裸賣選擇權的 Reg-T 保證金（美股／ETF 慣例）
     權利金收入 + max(標的市值 20% − 價外金額, 下限)
     下限：買權為標的市值 10%，賣權為履約價金額 10%
   風險無上限時「最大虧損」當不了分母，只能用這條公式估。
   注意這是 Reg-T 基準，券商的投資組合保證金會更低；台指選擇權用 SPAN，公式完全不同。 */
export function regTMargin(){
  let m = 0;
  for(const leg of state.legs){
    if(leg.type === "stock"){ m += Math.abs(leg.side*leg.qty*leg.premium); continue; }
    const n = leg.qty*state.mult;
    if(leg.side === 1){ m += leg.premium*n; continue; }   // 買方佔用的就是付出的權利金
    const U = state.S*n;
    const otm = leg.type === "call"
      ? Math.max(0, leg.K - state.S)*n
      : Math.max(0, state.S - leg.K)*n;
    const floor = leg.type === "call" ? 0.10*U : 0.10*leg.K*n;
    m += leg.premium*n + Math.max(0.20*U - otm, floor);
  }
  return m;
}

/* 佔用資金：買方是實際掏出的錢；風險有限的賣方用最大虧損；裸賣只能用 Reg-T 估。
   單一範本裡「付了借記」通常就等於「最多賠這麼多」，但範本一疊加就不是了——
   例如買權多頭疊上鐵兀鷹是淨借記，最大虧損卻是賣方價差的寬度，比借記大得多。
   分母取兩者的大者，百分比才不會出現 −294%（賠掉三倍投入）這種讀不通的數字。 */
export function capitalBase(a){
  const debit = -a.netPremium + a.stockCost;      // netPremium 正值＝淨收取
  const risk = isFinite(a.maxLoss) && a.maxLoss < 0 ? Math.abs(a.maxLoss) : Infinity;
  if(debit > 1e-9 && risk <= debit + 1e-6) return {amount:debit, short:"投入", full:"淨支出"};
  if(isFinite(risk))
    return debit > 1e-9
      ? {amount:risk, short:"最大風險", full:`最大風險（含淨支出 ${money(debit)}）`}
      : {amount:risk, short:"保證金", full:"最大風險約當保證金"};
  const m = regTMargin();
  if(m > 0) return {amount:m, short:"保證金", full:"Reg-T 估算保證金（裸賣）", estimated:true};
  return null;
}

// 部位現在的理論市值（不是成本）。波動倍數要拿它當分母：
// 資金槓桿問「相對投入的錢控制了多少曝險」，波動倍數問「手上這些東西會跟著漲跌幾 %」。
export function positionValue(d = state.tRem){
  let v = 0;
  for(const leg of state.legs){
    const n = leg.side * leg.qty * legMult(leg);
    if(leg.type === "stock"){ v += n*state.S; continue; }
    v += n * legValue(leg, state.S, d);
  }
  return v;
}

/* 希臘字母同樣按每一腳自己的剩餘天數算，加總才是部位真正的曝險。
   PMCC 的 Theta 為正就是這樣來的：近腳剩幾十天、每天掉得快，
   遠腳剩一年多、每天幾乎不掉，兩個 Theta 相加是淨收。

   這裡直接用 bs() 而不套 legValue() 的內含價值下界：下界只在深價內才咬得住，
   那一段的敏感度是「已經等同現股」的退化解（Delta 恰為 1、Gamma 與 Vega 為 0），
   拿它去畫敏感度曲線只會多出一道假的斷崖。現價附近兩者本來就相同。 */
export function greeks(d = state.tRem){
  const g = {delta:0, gamma:0, theta:0, vega:0, rho:0};
  for(const leg of state.legs){
    const n = leg.side * leg.qty * legMult(leg);
    if(leg.type === "stock"){ g.delta += n; continue; }
    const T = yearsLeft(legRem(leg, d));
    const k = bs(leg.type, state.S, leg.K, T, state.r/100, state.q/100, legIv(leg, d)/100);
    g.delta += n*k.delta; g.gamma += n*k.gamma;
    g.theta += n*k.theta; g.vega += n*k.vega; g.rho += n*k.rho;
  }
  return g;
}
