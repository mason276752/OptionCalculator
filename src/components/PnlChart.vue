<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import { state, isMulti, activeCombo, shownCombos, withCombo, comboPos, comboNeg, comboAcc, spotAnchor } from "../lib/state.js";
import { analyze, expiryPnl, pnlAt, legIv, riskThresholds } from "../lib/model.js";
import { nf, money, signedMoney, price } from "../lib/format.js";

const props = defineProps({ a: { type: Object, required: true } });

/* ---- 版面尺寸 ----
   SVG 寬度得從實際版面量，量到才知道要不要切成窄版；resize 去抖 120ms，
   拖動視窗時不必每一幀都把整張圖重算一遍。 */
const svgEl = ref(null);
const W = ref(720);
let resizeTimer;
function measure(){
  const el = svgEl.value;
  if(!el) return;
  W.value = Math.max(360, el.clientWidth || el.parentElement.clientWidth || 720);
}
function onResize(){
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(measure, 120);
}
onMounted(() => { measure(); addEventListener("resize", onResize); });
onBeforeUnmount(() => { clearTimeout(resizeTimer); removeEventListener("resize", onResize); });

function niceTicks(min, max, count){
  const span = (max - min) || 1;
  const raw = span/count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw/mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for(let v = Math.ceil(min/step)*step; v <= max + step*1e-6; v += step) out.push(+v.toFixed(10));
  return out;
}

const multi = computed(() => isMulti());

const geom = computed(() => {
  const a = props.a;
  const w = W.value;
  const narrow = w < 560;
  const H = narrow ? 300 : Math.max(300, Math.min(460, Math.round(w*0.48)));
  const M = narrow ? {t:20, r:30, b:40, l:52} : {t:22, r:70, b:42, l:76};
  const iw = w - M.l - M.r, ih = H - M.t - M.b;

  // 區間以錨點為中心，不是以 state.S——現價滑桿橫移時視窗要固定住（見 state.js）
  const lo = Math.max(0, spotAnchor.value*(1 - state.rangePct/100));
  const hi = spotAnchor.value*(1 + state.rangePct/100);

  // 每一套顯示中的組合各掃一次曲線。取樣格是共用的，兩條線才落在同一批 x 上，
  // 游標與末端標籤也才對得起來。
  const isM = isMulti();
  const act = activeCombo();
  const N = 240;
  const xs = [];
  for(let i=0;i<=N;i++) xs.push(lo + (hi-lo)*i/N);
  const series = shownCombos().map(c => withCombo(c, () => ({
    c,
    pos: isM ? comboPos(c) : "var(--pos)",
    neg: isM ? comboNeg(c) : "var(--neg)",
    acc: isM ? comboAcc(c) : "var(--accent)",
    a: c === act ? a : analyze(),
    pts: xs.map(S => ({S, exp:expiryPnl(S), now:pnlAt(S, state.tRem)}))
  })));
  const strikes = [...new Set(series.flatMap(s => s.a.strikes))].sort((p,q) => p - q);

  let yMin = Infinity, yMax = -Infinity;
  for(const s of series) for(const p of s.pts){
    yMin = Math.min(yMin, p.exp, p.now);
    yMax = Math.max(yMax, p.exp, p.now);
  }
  const pad = ((yMax - yMin) || Math.abs(yMax) || 100)*0.14;
  yMin -= pad; yMax += pad;
  if(yMin > 0) yMin = -pad; if(yMax < 0) yMax = pad;

  const x = S => M.l + (S - lo)/(hi - lo)*iw;
  const y = v => M.t + (yMax - v)/(yMax - yMin)*ih;
  const invX = px => lo + (px - M.l)/iw*(hi - lo);

  const line = (pts, key) => pts.map((p,i) => (i ? "L" : "M") + x(p.S).toFixed(2) + " " + y(p[key]).toFixed(2)).join(" ");
  const area = (pts, key) => line(pts, key) + ` L${x(hi).toFixed(2)} ${y(0).toFixed(2)} L${x(lo).toFixed(2)} ${y(0).toFixed(2)} Z`;

  const y0 = y(0);
  const drawn = series.map(s => ({
    ...s,
    dExp: line(s.pts, "exp"),
    dNow: line(s.pts, "now"),
    dArea: area(s.pts, "exp"),
    // 兩條線之間的落差就是尚未流失的時間價值
    dBand: state.tRem > 0
      ? line(s.pts, "now") + " " +
        s.pts.slice().reverse().map(p => `L${x(p.S).toFixed(2)} ${y(p.exp).toFixed(2)}`).join(" ") + " Z"
      : ""
  }));

  /* 曲線末端直接標示（窄版空間不足，改由圖例辨識）。
     多套時標的是組合名字：分類配色有幾階在淺色底下對比不足，
     名字寫在線末，不必靠顏色也認得出誰是誰。 */
  let endLabels = [];
  if(!narrow){
    if(!isM){
      const last = drawn[0].pts[drawn[0].pts.length-1];
      // 兩條曲線在右端常常幾乎重合（跨到期日的部位尤其如此，近腳被指派之後
      // 兩者只差遠腳的時間價值），標籤要先推開才讀得到
      let yExp = y(last.exp), yNow = y(last.now);
      if(state.tRem > 0 && Math.abs(yExp - yNow) < 12){
        const mid = (yExp + yNow)/2, off = yExp <= yNow ? -6 : 6;
        yExp = mid + off; yNow = mid - off;
      }
      endLabels.push({y:yExp, color:last.exp >= 0 ? "var(--pos)" : "var(--neg)", text:a.diagonal ? "近腳到期" : "到期"});
      if(state.tRem > 0) endLabels.push({y:yNow, color:"var(--accent)", text:"T+n"});
    }else{
      // 由上而下依序推開，最少留 12px；推到超出畫布下緣就整批往上平移
      endLabels = drawn.map(s => {
        const last = s.pts[s.pts.length-1];
        return {
          y: y(last.exp), color: last.exp >= 0 ? s.pos : s.neg,
          text: s.c.name.length > 6 ? s.c.name.slice(0, 5) + "…" : s.c.name
        };
      }).sort((p, q) => p.y - q.y);
      for(let i = 1; i < endLabels.length; i++)
        if(endLabels[i].y - endLabels[i-1].y < 12) endLabels[i].y = endLabels[i-1].y + 12;
      const over = endLabels.length ? endLabels[endLabels.length-1].y - (M.t + ih) : 0;
      if(over > 0) for(const l of endLabels) l.y -= over;
    }
  }

  return {
    W:w, H, M, iw, ih, lo, hi, narrow, multi:isM, act, x, y, invX, y0,
    series:drawn, strikes, endLabels,
    xTicks: niceTicks(lo, hi, narrow ? 4 : 7),
    yTicks: niceTicks(yMin, yMax, narrow ? 4 : 5),
    cur: drawn.find(s => s.c === act) || null
  };
});

/* ---- 帳戶資金與強制平倉 ----
   問的是「標的走到哪會出事」，所以答案畫成 x 軸上的警戒區間，而不是 y 軸上的水平線：
   資金一大，「維持保證金 − 資金」會掉到 −80,000 以下，早就跑出圖的 y 範圍看不到了；
   價位則永遠落在橫軸上。追繳區從門檻價位往外延伸，歸零區疊在更外面。
   門檻用 T+n 的理論損益求解——追繳是現在會發生的事，拿到期損益去比會低估風險，
   因為那時時間價值早就走完了。
   顏色刻意不用紅綠：紅綠在這個工具裡專講漲跌，警戒區借用會讀成「跌就是危險」。 */
const risk = computed(() => {
  const cap = state.capital;
  if(!(cap > 0)) return null;
  const g = geom.value;
  const th = riskThresholds(props.a, cap, state.tRem);
  const right = g.M.l + g.iw;
  // 把門檻價位換成畫面上的一塊區間；完全落在可視範圍外就不畫
  const zone = (v, side) => {
    if(v == null) return null;
    if(side === "down"){
      if(v <= g.lo) return null;
      const at = g.x(Math.min(v, g.hi));
      return {x: g.M.l, w: at - g.M.l, at, inside: v < g.hi};
    }
    if(v >= g.hi) return null;
    const at = g.x(Math.max(v, g.lo));
    return {x: at, w: right - at, at, inside: v > g.lo};
  };
  const zones = [], marks = [];
  for(const [key, text, op] of [["call", "追繳", .06], ["zero", "歸零", .09]])
    for(const [side, anchor] of [["down", "end"], ["up", "start"]]){
      const z = zone(th[key][side], side);
      if(!z) continue;
      zones.push({...z, op});
      if(z.inside) marks.push({x: z.at, text, anchor});
    }
  return {th, zones, marks};
});

const riskText = computed(() => {
  const r = risk.value;
  if(!r) return "";
  const t = r.th;
  // 連建倉的錢都不夠，就沒有「什麼時候被追繳」可談了
  if(t.shortfall > 0.005)
    return `⚠ 建倉支出 ${money(state.capital + t.shortfall)} 超過帳戶資金 ${money(state.capital)}`
      + `，還差 ${money(t.shortfall)}——這個部位開不起來。`;
  if(t.breached)
    return `⚠ 目前權益 ${money(t.equityNow)} 已經低於維持保證金 ${money(t.maintNow)}`
      + `——以這筆資金，這個部位一建倉就在追繳狀態。`;
  const at = S => `${price(S)}（${S >= state.S ? "+" : "−"}${nf(Math.abs(S/state.S - 1)*100, 1)}%）`;
  const leg = (side, verb) => {
    const bits = [];
    if(t.call[side] != null) bits.push(`${verb}到 ${at(t.call[side])} 觸發追繳`);
    if(t.zero[side] != null) bits.push(`${verb}到 ${at(t.zero[side])} 權益歸零`);
    return bits.join("、");
  };
  const parts = [leg("down", "跌"), leg("up", "漲")].filter(Boolean);
  const head = `資金 ${money(state.capital)}：權益 ${money(t.equityNow)}、維持保證金 ${money(t.maintNow)}`
    + `，緩衝 ${money(t.buffer)}。`;
  return head + (parts.length
    ? parts.join("；") + "。"
    : "這個部位的虧損上限吃不掉這筆資金，不會被追繳或歸零。");
});

/* ---- 游標吸附 ----
   圖上真正要讀數字的位置就那幾個：現價、各腳的履約價、各組合的兩平點。
   曲線在那裡轉折，隔壁一個像素的數字沒有意義，徒手對準只是折磨手腕，
   所以游標靠近就黏上去。想讀任意價位（例如「跌到 690 賠多少」）時，
   按住 Shift／⌘／Ctrl／Alt 任一個就暫時關掉。 */
const SNAP_PX = 11;
const MOD_KEYS = new Set(["Shift", "Meta", "Control", "Alt"]);
const modHeld = ev => !!(ev.shiftKey || ev.metaKey || ev.ctrlKey || ev.altKey);

const snapTargets = computed(() => {
  const g = geom.value;
  const m = new Map();
  const put = (v, tag) => {
    if(!(v >= g.lo && v <= g.hi)) return;
    // 履約價與兩平點常常只差幾分錢，落在同一個像素上就併成一個吸附點
    const k = +v.toFixed(4);
    const hit = m.get(k);
    if(hit){ if(!hit.tags.includes(tag)) hit.tags.push(tag); }
    else m.set(k, {S:k, tags:[tag]});
  };
  put(state.S, "現價");
  for(const s of g.series){
    for(const k of s.a.strikes) put(k, "履約價");
    for(const b of s.a.breakevens) put(b, "兩平");
  }
  return [...m.values()].sort((p, q) => p.S - q.S);
});

// {clientX, free}；free 為 true 表示按著修飾鍵，暫時不吸附
const pointer = ref(null);

const cursor = computed(() => {
  if(!pointer.value || !svgEl.value) return null;
  const g = geom.value;
  const rect = svgEl.value.getBoundingClientRect();
  const px = (pointer.value.clientX - rect.left)/rect.width*g.W;
  let S = Math.min(g.hi, Math.max(g.lo, g.invX(px)));

  // 吸附：找螢幕上最近的關鍵價位，夠近就黏過去
  let snap = null;
  if(!pointer.value.free){
    let best = SNAP_PX;
    for(const t of snapTargets.value){
      const d = Math.abs(g.x(t.S) - px);
      if(d <= best){ best = d; snap = t; }
    }
    if(snap) S = snap.S;
  }
  // 游標落在取樣點之間，直接用該組合的模型重算一次，不從畫線的點內插
  const vals = g.series.map(s => withCombo(s.c, () => ({
    e: expiryPnl(S), n: pnlAt(S, state.tRem)
  })));
  return {S, snap, vals};
});

// 提示框：單套講的是「這一條線的三個部分」，多套講的是「哪一列是哪一套」
const tip = computed(() => {
  const c = cursor.value;
  if(!c) return null;
  const g = geom.value, S = c.S, vals = c.vals;
  // 吸附中的話，把黏在哪個關鍵價位上寫出來——不然數字剛好落在整數上會看不出是巧合還是吸附
  const tagText = c.snap ? c.snap.tags.slice(0, 2).join("／") : "";

  let bw, bh, rows = null, cols = null;
  if(!g.multi){
    const {e, n} = vals[0];
    rows = [
      ["標的", price(S), "var(--ink)"],
      [g.series[0].a.diagonal ? "近腳到期" : "到期", signedMoney(e), e >= 0 ? "var(--pos)" : "var(--neg)"]
    ];
    if(state.tRem > 0){
      rows.push(["T+n", signedMoney(n), "var(--accent)"]);
      rows.push(["時間價值", money(n - e), "var(--ink-2)"]);
    }
    // 偏斜慣例會讓 IV 隨標的移動，把實際採用的值攤開來
    if(state.ivSkew === "moneyness" && state.legs.length === 1 && state.legs[0].type !== "stock"){
      const lg = state.legs[0];
      rows.push(["IV", nf(legIv(lg, state.tRem, S), 1) + "%", "var(--ink-2)"]);
    }
    bw = tagText ? 168 : 146; bh = 16 + rows.length*17;
  }else{
    // 一套一列：色票＋名字認身分，右邊兩欄是到期與 T+n，直接上下對照
    const withNow = state.tRem > 0;
    bw = withNow ? 232 : 178;
    bh = 16 + (2 + g.series.length)*17;
    const colExp = withNow ? 78 : 10;
    cols = {
      withNow, colExp,
      list: g.series.map((s, i) => ({
        s, v: vals[i],
        name: s.c.name.length > 5 ? s.c.name.slice(0,4) + "…" : s.c.name
      }))
    };
  }
  const bx = Math.min(g.W - g.M.r - bw, Math.max(g.M.l, g.x(S) + 12));
  const by = Math.max(g.M.t, Math.min(g.H - g.M.b - bh, g.y(vals[0].e) - bh - 10));
  return {bx, by, bw, bh, rows, cols, tagText, S};
});

// 觸控沒有修飾鍵可按，一律吸附——手指本來就對不準，吸附只有好處
function move(ev){
  const p = ev.touches ? ev.touches[0] : ev;
  pointer.value = {clientX: p.clientX, free: ev.touches ? false : modHeld(ev)};
}
function leave(){ pointer.value = null; }

/* 按住／放開修飾鍵時，游標得就地改變吸附狀態，不能等到下一次滑鼠移動。 */
function onKey(ev){
  if(!MOD_KEYS.has(ev.key) || !pointer.value) return;
  pointer.value = {...pointer.value, free: modHeld(ev)};
}
onMounted(() => { addEventListener("keydown", onKey); addEventListener("keyup", onKey); });
onBeforeUnmount(() => { removeEventListener("keydown", onKey); removeEventListener("keyup", onKey); });

const tRemLabel = computed(() => state.tRem === 0
  ? "到期日"
  : "剩 " + state.tRem + " 天（已過 " + (state.dte - state.tRem) + " 天）");

/* ---- 現價：直接拖圖上那個標籤 ----
   拖動就是改 state.S，摘要、希臘字母、保證金、目前損益全部跟著走。
   把手只放在標籤上，垂直線本身不接受拖曳——整條線都是熱區的話，
   它會跨越整個繪圖區，跟讀值游標搶滑鼠。
   級距取「約 400 段」附近的整齊數字，免得拖出 714.2500001 這種讀不出所以然的價格。 */
const NICE_STEPS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100];
const spotStep = computed(() => {
  const raw = (geom.value.hi - geom.value.lo)/400;
  return NICE_STEPS.find(s => s >= raw) ?? 250;
});
const atAnchor = computed(() => Math.abs(state.S/spotAnchor.value - 1) < 5e-5);
const spotTag = computed(() => {
  const d = state.S/spotAnchor.value - 1;
  return "現價 " + price(state.S)
    + (atAnchor.value ? "" : `　${d >= 0 ? "+" : "−"}${nf(Math.abs(d)*100, 1)}%`);
});

/* 把手永遠畫得出來：現價被夾在可視區間內取位置。
   縮小圖表範圍時現價可能落到區間外，若跟著隱藏，就再也抓不回來了。 */
const spotX = computed(() => {
  const g = geom.value;
  return g.x(Math.min(g.hi, Math.max(g.lo, state.S)));
});
// 標籤靠右邊界時翻到線的左側，才不會被裁掉
const spotLabelPos = computed(() => {
  const g = geom.value;
  const w = [...spotTag.value].reduce((a, c) => a + (c.charCodeAt(0) > 0x2000 ? 10.5 : 6.3), 0);
  const flip = spotX.value + 8 + w > g.M.l + g.iw;
  return {x: flip ? spotX.value - 8 : spotX.value + 8, anchor: flip ? "end" : "start"};
});

const dragging = ref(false);
function moveSpotTo(clientX){
  const g = geom.value;
  const rect = svgEl.value.getBoundingClientRect();
  const px = (clientX - rect.left)/rect.width*g.W;
  const st = spotStep.value;
  // 先吸到級距上，再夾進區間——順序反過來的話，四捨五入會把值推出區間半格，
  // 把手就跑到圖外去了
  const snapped = Math.round(g.invX(px)/st)*st;
  state.S = +Math.min(g.hi, Math.max(g.lo, snapped)).toFixed(6);
}
function onSpotDown(ev){
  ev.preventDefault();
  dragging.value = true;
  pointer.value = null;               // 拖動時把讀值游標收起來，兩條十字線疊著很吵
  try{ ev.currentTarget.setPointerCapture(ev.pointerId); }catch(e){/* 舊瀏覽器沒有就算了 */}
}
function onSpotMove(ev){ if(dragging.value) moveSpotTo(ev.clientX); }
function onSpotUp(ev){
  if(!dragging.value) return;
  dragging.value = false;
  try{ ev.currentTarget.releasePointerCapture(ev.pointerId); }catch(e){/* 已經放掉了 */}
}
</script>

<template>
  <figure class="chart">
    <div class="chart-head">
      <p class="chart-title">損益曲線</p>
      <!-- 圖例。單套時說明的是「這一條線的三個部分」（到期／T+n／中間的時間價值），
           多套時要說明的是「哪一組深淺是哪一套」，兩者是不同的問題，所以整塊換掉。 -->
      <div class="legend">
        <template v-if="!multi">
          <span><i class="swatch" style="background:var(--pos)"></i><i class="swatch" style="background:var(--neg)"></i>到期損益</span>
          <span><i class="swatch" style="background:var(--accent)"></i>T+n 理論損益</span>
          <span><i class="swatch block" style="background:var(--accent); opacity:.28"></i>時間價值</span>
        </template>
        <template v-else>
          <span v-for="c in state.combos" :key="c.id" :class="{off: !c.on}">
            <i class="swatch" :style="{background: comboPos(c)}"></i>
            <i class="swatch" :style="{background: comboNeg(c)}"></i>
            <i class="swatch dash" :style="{borderTopColor: comboAcc(c)}"></i>{{ c.name }}
          </span>
          <span class="note">實線＝到期（紅綠依漲跌）　虛線＝T+n</span>
        </template>
      </div>
    </div>

    <svg class="plot" ref="svgEl" role="img" aria-label="選擇權損益曲線圖"
      :viewBox="`0 0 ${geom.W} ${geom.H}`" :height="geom.H">
      <defs>
        <clipPath id="clipUp"><rect :x="geom.M.l" :y="geom.M.t" :width="geom.iw" :height="Math.max(0, geom.y0 - geom.M.t)"/></clipPath>
        <clipPath id="clipDn"><rect :x="geom.M.l" :y="geom.y0" :width="geom.iw" :height="Math.max(0, geom.M.t + geom.ih - geom.y0)"/></clipPath>
        <clipPath id="clipPlot"><rect :x="geom.M.l" :y="geom.M.t" :width="geom.iw" :height="geom.ih"/></clipPath>
      </defs>

      <!-- 座標格線 -->
      <line v-for="t in geom.yTicks" :key="'gy'+t" :x1="geom.M.l" :y1="geom.y(t)" :x2="geom.M.l+geom.iw" :y2="geom.y(t)" stroke="var(--grid)" stroke-width="1"/>
      <line v-for="t in geom.xTicks" :key="'gx'+t" :x1="geom.x(t)" :y1="geom.M.t" :x2="geom.x(t)" :y2="geom.M.t+geom.ih" stroke="var(--grid)" stroke-width="1"/>

      <!-- 履約價（多套時是所有顯示中組合的履約價聯集） -->
      <template v-for="k in geom.strikes.filter(k => k >= geom.lo && k <= geom.hi)" :key="'k'+k">
        <line :x1="geom.x(k)" :y1="geom.M.t" :x2="geom.x(k)" :y2="geom.M.t+geom.ih" stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="2 4" opacity=".55"/>
        <text :x="geom.x(k)" :y="geom.M.t+geom.ih+27" text-anchor="middle" font-family="var(--mono)" font-size="10" fill="var(--ink-3)">K {{ price(k) }}</text>
      </template>

      <!-- 資金警戒區：標的走進這一段就會出事。畫在損益曲線之前，曲線才壓得住 -->
      <g v-if="risk" clip-path="url(#clipPlot)">
        <rect v-for="(z, i) in risk.zones" :key="'z'+i"
          :x="z.x" :y="geom.M.t" :width="z.w" :height="geom.ih" fill="var(--ink)" :opacity="z.op"/>
        <template v-for="(m, i) in risk.marks" :key="'m'+i">
          <line :x1="m.x" :y1="geom.M.t" :x2="m.x" :y2="geom.M.t+geom.ih"
            stroke="var(--ink-2)" stroke-width="1" stroke-dasharray="6 3"/>
          <text :x="m.x + (m.anchor === 'end' ? -4 : 4)" :y="geom.M.t+geom.ih-5" :text-anchor="m.anchor"
            font-family="var(--mono)" font-size="9.5" fill="var(--ink-2)">{{ m.text }}</text>
        </template>
      </g>

      <!-- 只有一套組合時，面積與紅綠是在講「賺還是賠」；多套疊上來之後同一塊顏色
           會同時屬於好幾條曲線，那個語意就崩了——所以改成一套一個顏色，
           實線是到期、虛線是 T+n，面積全部拿掉。 -->
      <template v-if="!geom.multi">
        <path :d="geom.series[0].dArea" fill="var(--pos)" opacity=".12" clip-path="url(#clipUp)"/>
        <path :d="geom.series[0].dArea" fill="var(--neg)" opacity=".12" clip-path="url(#clipDn)"/>
        <path v-if="state.tRem > 0" :d="geom.series[0].dBand" fill="var(--accent)" opacity=".1" clip-path="url(#clipPlot)"/>
        <!-- 零軸（同時作為兩塊面積之間的分隔） -->
        <line :x1="geom.M.l" :y1="geom.y0" :x2="geom.M.l+geom.iw" :y2="geom.y0" stroke="var(--ink-2)" stroke-width="1.5"/>
        <path v-if="state.tRem > 0" :d="geom.series[0].dNow" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" clip-path="url(#clipPlot)"/>
        <path :d="geom.series[0].dExp" fill="none" stroke="var(--pos)" stroke-width="2.5" stroke-linejoin="round" clip-path="url(#clipUp)"/>
        <path :d="geom.series[0].dExp" fill="none" stroke="var(--neg)" stroke-width="2.5" stroke-linejoin="round" clip-path="url(#clipDn)"/>
      </template>
      <template v-else>
        <!-- 正在編輯的那一套鋪一層極淡的面積，讓視線在一堆線裡找得到它 -->
        <template v-if="geom.cur">
          <path :d="geom.cur.dArea" :fill="geom.cur.pos" opacity=".07" clip-path="url(#clipUp)"/>
          <path :d="geom.cur.dArea" :fill="geom.cur.neg" opacity=".07" clip-path="url(#clipDn)"/>
        </template>
        <line :x1="geom.M.l" :y1="geom.y0" :x2="geom.M.l+geom.iw" :y2="geom.y0" stroke="var(--ink-2)" stroke-width="1.5"/>
        <!-- T+n 全部先畫、到期後畫：重疊時該讀的是到期那條 -->
        <template v-if="state.tRem > 0">
          <path v-for="s in geom.series" :key="'n'+s.c.id" :d="s.dNow" fill="none" :stroke="s.acc" stroke-width="1.6" stroke-dasharray="5 4" stroke-linejoin="round" clip-path="url(#clipPlot)"/>
        </template>
        <!-- 到期線照樣以零軸為界分成紅綠兩段，只是換成這一套自己的深淺 -->
        <template v-for="s in geom.series" :key="'e'+s.c.id">
          <path :d="s.dExp" fill="none" :stroke="s.pos" stroke-width="2.4" stroke-linejoin="round" clip-path="url(#clipUp)"/>
          <path :d="s.dExp" fill="none" :stroke="s.neg" stroke-width="2.4" stroke-linejoin="round" clip-path="url(#clipDn)"/>
        </template>
      </template>

      <!-- 損益兩平點；多套時填自己的身分色，才知道這個點是誰的 -->
      <template v-for="s in geom.series" :key="'b'+s.c.id">
        <circle v-for="b in s.a.breakevens.filter(b => b >= geom.lo && b <= geom.hi)" :key="b"
          :cx="geom.x(b)" :cy="geom.y0" r="4.5"
          :fill="geom.multi ? s.acc : 'var(--card)'" :stroke="geom.multi ? 'var(--card)' : 'var(--ink)'" stroke-width="2"/>
      </template>

      <!-- 現價的垂直線與標籤；可拖的倒三角另外畫在游標熱區之上 -->
      <g style="pointer-events:none">
        <line :x1="spotX" :y1="geom.M.t" :x2="spotX" :y2="geom.M.t+geom.ih"
          stroke="var(--ink)" stroke-width="1" stroke-dasharray="4 3" :opacity="dragging ? '.9' : '.6'"/>
        <text :x="spotLabelPos.x" :y="geom.M.t+21" :text-anchor="spotLabelPos.anchor"
          font-family="var(--mono)" font-size="10.5"
          :fill="dragging ? 'var(--accent)' : 'var(--ink-2)'">{{ spotTag }}</text>
      </g>

      <!-- 軸標籤 -->
      <text v-for="t in geom.yTicks" :key="'ty'+t" :x="geom.M.l-10" :y="geom.y(t)+3.5" text-anchor="end" font-family="var(--mono)" font-size="10.5" fill="var(--ink-3)">{{ money(t) }}</text>
      <text v-for="t in geom.xTicks" :key="'tx'+t" :x="geom.x(t)" :y="geom.M.t+geom.ih+15" text-anchor="middle" font-family="var(--mono)" font-size="10.5" fill="var(--ink-3)">{{ price(t) }}</text>
      <text :x="geom.M.l" :y="geom.M.t-8" font-family="var(--mono)" font-size="10" letter-spacing=".1em" fill="var(--ink-3)">損益</text>
      <text :x="geom.M.l+geom.iw" :y="geom.M.t+geom.ih+38" text-anchor="end" font-family="var(--mono)" font-size="10" letter-spacing=".1em" fill="var(--ink-3)">標的價格</text>

      <text v-for="(l, i) in geom.endLabels" :key="'el'+i" :x="geom.M.l+geom.iw+6" :y="l.y+3.5" font-family="var(--mono)" font-size="10.5" :fill="l.color">{{ l.text }}</text>

      <!-- 游標層：每一套組合各一對圓點（實線一個、虛線一個） -->
      <g v-if="cursor">
        <line :x1="geom.x(cursor.S)" :y1="geom.M.t" :x2="geom.x(cursor.S)" :y2="geom.M.t+geom.ih" stroke="var(--ink)" stroke-width="1" :opacity="cursor.snap ? '.75' : '.45'"/>
        <!-- 黏住時在底軸補一個小三角，滑鼠不必離開曲線也看得出「現在是吸附狀態」 -->
        <path v-if="cursor.snap" d="M0 0 l-4 -5 l8 0 Z" fill="var(--ink)" :transform="`translate(${geom.x(cursor.S)} ${geom.M.t + geom.ih})`"/>
        <template v-for="(v, i) in cursor.vals" :key="'c'+i">
          <circle :cx="geom.x(cursor.S)" :cy="geom.y(v.e)" r="4.5"
            :fill="v.e >= 0 ? geom.series[i].pos : geom.series[i].neg" stroke="var(--card)" stroke-width="2"/>
          <circle v-if="state.tRem > 0" :cx="geom.x(cursor.S)" :cy="geom.y(v.n)" :r="geom.multi ? 3.5 : 4.5"
            :fill="geom.series[i].acc" stroke="var(--card)" stroke-width="2"/>
        </template>
      </g>

      <g v-if="tip">
        <rect :x="tip.bx" :y="tip.by" :width="tip.bw" :height="tip.bh" rx="2" fill="var(--card)" stroke="var(--rule)"/>
        <template v-if="tip.rows">
          <template v-for="(r, i) in tip.rows" :key="'r'+i">
            <text :x="tip.bx+10" :y="tip.by+20+i*17" font-family="var(--mono)" font-size="11" fill="var(--ink-3)">{{ r[0] }}</text>
            <text v-if="i === 0 && tip.tagText" :x="tip.bx+36" :y="tip.by+20" font-family="var(--sans)" font-size="10" fill="var(--accent)">{{ tip.tagText }}</text>
            <text :x="tip.bx+tip.bw-10" :y="tip.by+20+i*17" text-anchor="end" font-family="var(--mono)" font-size="11.5" :fill="r[2]">{{ r[1] }}</text>
          </template>
        </template>
        <template v-else>
          <text :x="tip.bx+10" :y="tip.by+20" font-family="var(--mono)" font-size="11" fill="var(--ink-3)">標的</text>
          <text v-if="tip.tagText" :x="tip.bx+36" :y="tip.by+20" font-family="var(--sans)" font-size="10" fill="var(--accent)">{{ tip.tagText }}</text>
          <text :x="tip.bx+tip.bw-10" :y="tip.by+20" text-anchor="end" font-family="var(--mono)" font-size="11.5" fill="var(--ink)">{{ price(tip.S) }}</text>
          <line :x1="tip.bx+8" :y1="tip.by+27" :x2="tip.bx+tip.bw-8" :y2="tip.by+27" stroke="var(--rule)" stroke-width="1"/>
          <text :x="tip.bx+tip.bw-10-tip.cols.colExp" :y="tip.by+40" text-anchor="end" font-family="var(--mono)" font-size="10" fill="var(--ink-3)">到期</text>
          <text v-if="tip.cols.withNow" :x="tip.bx+tip.bw-10" :y="tip.by+40" text-anchor="end" font-family="var(--mono)" font-size="10" fill="var(--ink-3)">T+n</text>
          <template v-for="(row, i) in tip.cols.list" :key="'m'+i">
            <!-- 色票用這一套的三個階，和圖上那三條線對得起來 -->
            <rect :x="tip.bx+10" :y="tip.by+57+i*17-8" width="4" height="8" :fill="row.s.pos"/>
            <rect :x="tip.bx+14" :y="tip.by+57+i*17-8" width="4" height="8" :fill="row.s.neg"/>
            <text :x="tip.bx+23" :y="tip.by+57+i*17" font-family="var(--sans)" font-size="11" fill="var(--ink-2)">{{ row.name }}</text>
            <text :x="tip.bx+tip.bw-10-tip.cols.colExp" :y="tip.by+57+i*17" text-anchor="end" font-family="var(--mono)" font-size="11.5" :fill="row.v.e >= 0 ? row.s.pos : row.s.neg">{{ signedMoney(row.v.e) }}</text>
            <text v-if="tip.cols.withNow" :x="tip.bx+tip.bw-10" :y="tip.by+57+i*17" text-anchor="end" font-family="var(--mono)" font-size="11.5" :fill="row.s.acc">{{ signedMoney(row.v.n) }}</text>
          </template>
        </template>
      </g>

      <rect class="hit" :x="geom.M.l" :y="geom.M.t" :width="geom.iw" :height="geom.ih" fill="transparent" style="cursor:crosshair"
        @mousemove="move" @mouseleave="leave"
        @touchstart.passive="move" @touchmove.passive="move" @touchend="leave"/>

      <!-- 現價把手：垂直線頂端的倒三角。畫在熱區之上才收得到滑鼠。
           熱區只有這個小三角，線本身不吃滑鼠——整條線都是熱區會跟讀值游標搶。
           雙擊回到基準價。 -->
      <g class="spot-handle" :class="{on: dragging}"
        @pointerdown="onSpotDown" @pointermove="onSpotMove"
        @pointerup="onSpotUp" @pointercancel="onSpotUp"
        @dblclick="state.S = spotAnchor">
        <rect :x="spotX - 13" :y="geom.M.t - 4" width="26" height="22" fill="transparent"/>
        <path :d="`M${spotX - 7} ${geom.M.t + 1} L${spotX + 7} ${geom.M.t + 1} L${spotX} ${geom.M.t + 11} Z`"
          :fill="dragging ? 'var(--accent)' : 'var(--ink)'" stroke="var(--card)" stroke-width="1.5"/>
      </g>
    </svg>

    <p class="chart-hint">
      游標會吸附到現價、履約價與損益兩平點；按住 <kbd>Shift</kbd>（或 <kbd>⌘</kbd>／<kbd>Ctrl</kbd>／<kbd>Alt</kbd>）可讀任意價位。
      拖動現價線頂端的<b>倒三角</b>可左右移動整條線，摘要與保證金會跟著重算；雙擊三角回到基準價。
      <button v-if="!atAnchor" class="btn btn-ghost btn-mono" type="button"
        title="把現價移回基準價" @click="state.S = spotAnchor">歸位</button>
    </p>
    <p class="chart-risk" v-if="riskText" :class="{warn: risk.th.breached || risk.th.shortfall > 0.005}">{{ riskText }}</p>
    <div class="timebar">
      <label for="tRem">模擬時點</label>
      <input type="range" id="tRem" min="0" :max="state.dte" step="1"
        :value="state.tRem" @input="state.tRem = +$event.target.value">
      <output>{{ tRemLabel }}</output>
    </div>
  </figure>
</template>
