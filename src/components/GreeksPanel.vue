<script setup>
import { computed, ref } from "vue";
import { state, isMulti, activeCombo, shownCombos, withCombo, comboAcc } from "../lib/state.js";
import { analyze, capitalBase, greeks, positionValue } from "../lib/model.js";
import { nf, signedMoney } from "../lib/format.js";

const props = defineProps({ a: { type: Object, required: true } });

/* ---- 敏感度隨剩餘天數的變化（小倍數圖） ----
   七個指標的量級天差地遠（Delta 是股數、Theta 是錢、槓桿是倍數），
   共用一個 y 軸沒有意義，所以各自一張小圖、各自一個 y 軸。 */
const SPARK_W = 200, SPARK_H = 68, SPARK_N = 90;

const GREEK_META = [
  {k:"delta", g:"Δ Delta", h:"等值股數",       fmt:v => nf(v, 2)},
  {k:"gamma", g:"Γ Gamma", h:"Delta／每 1 元", fmt:v => nf(v, 4)},
  {k:"theta", g:"Θ Theta", h:"每日時間價值",   fmt:signedMoney},
  {k:"decay", g:"ΣΘ 累計耗損", h:"自建倉起算",  fmt:signedMoney},
  {k:"vega",  g:"ν Vega",  h:"IV 每 +1%",     fmt:signedMoney},
  {k:"rho",   g:"ρ Rho",   h:"利率每 +1%",    fmt:signedMoney},
  // 分母是 capitalBase()，不一定是「投入」——合成多頭那類部位走的是最大風險
  {k:"lev",   g:"資金槓桿", h:"曝險 ÷ 資金基準", fmt:v => isFinite(v) ? nf(v, 2) + "×" : "—"},
  {k:"omega", g:"波動倍數", h:"標的 ±1% 的放大", fmt:v => isFinite(v) ? nf(v, 2) + "×" : "—"}
];

function buildSensitivity(a){
  const cap = capitalBase(a);
  // 取樣到剩 1 天為止：剩 0 天時模型只剩內含價值，Gamma／Vega 會直接掉成 0，
  // 那是模型的邊界而不是市場行為，畫進去會變成一道假的斷崖。
  const from = Math.max(1, state.dte), to = 1;
  const days = [], series = {delta:[], gamma:[], theta:[], vega:[], rho:[], lev:[], omega:[], decay:[]};
  // 累計耗損以建倉時點的理論價為基準：Theta 每天都在變，把它逐日相加會失真，
  // 直接拿兩個時點的理論價相減才是「這段期間被時間吃掉多少」。標的價固定在現值。
  const val0 = positionValue(from);
  for(let i = 0; i <= SPARK_N; i++){
    const d = from + (to - from)*i/SPARK_N;
    const g = greeks(d), notional = g.delta*state.S, val = positionValue(d);
    days.push(d);
    series.delta.push(g.delta); series.gamma.push(g.gamma); series.theta.push(g.theta);
    series.vega.push(g.vega);   series.rho.push(g.rho);
    series.lev.push(cap && cap.amount > 0 ? Math.abs(notional)/cap.amount : NaN);
    series.omega.push(Math.abs(val) > 1e-6 ? Math.abs(notional)/Math.abs(val) : NaN);
    series.decay.push(val - val0);
  }
  return {days, series, cap};
}

/* 一張小圖的 y 軸。多套組合疊在同一張圖裡時，範圍必須取所有曲線的聯集——
   各畫各的軸就會讓 Delta 60 和 Delta 6 長成一模一樣的形狀，高低完全讀不出來。
   範圍用資料自身的區間、不強制含 0：這些小圖要看的是「形狀怎麼變」，
   硬把 0 塞進來會讓 Delta 這種在 55–63 之間走動的曲線壓成一條直線。 */
function sparkScale(seriesList){
  const ok = seriesList.flat().filter(isFinite);
  if(!ok.length) return null;
  let lo = Math.min(...ok), hi = Math.max(...ok);
  if(hi - lo < 1e-12){ lo -= 0.5; hi += 0.5; }
  const pad = (hi - lo)*0.15;
  lo -= pad; hi += pad;
  const n = seriesList[0].length;
  const y = v => SPARK_H - (v - lo)/(hi - lo)*SPARK_H;
  return {lo, hi, y, x: i => i/(n - 1)*SPARK_W, zero: lo <= 0 && hi >= 0 ? y(0) : null};
}

function sparkPath(vals, sc){
  let d = "", started = false;
  vals.forEach((v, i) => {
    if(!isFinite(v)){ started = false; return; }
    d += (started ? "L" : "M") + sc.x(i).toFixed(1) + " " + sc.y(v).toFixed(1) + " ";
    started = true;
  });
  return d;
}

const model = computed(() => {
  const multi = isMulti();
  const act = activeCombo();
  // 每一套顯示中的組合各算一份敏感度；取樣的天數格是共用的，所以 x 軸天生對齊
  // 敏感度沒有漲跌的正負語意，一律走藍色那一階（也就是這一套的身分色）
  const views = shownCombos().map(c => withCombo(c, () => {
    const s = buildSensitivity(c === act ? props.a : analyze());
    return {c, color: multi ? comboAcc(c) : "var(--accent)", days:s.days, series:s.series};
  }));
  const iAct = Math.max(0, views.findIndex(v => v.c === act));
  const scales = {};
  for(const m of GREEK_META) scales[m.k] = sparkScale(views.map(v => v.series[m.k]));
  return {views, days:views[0].days, scales, iAct};
});

// 游標所在的取樣索引；沒有游標時定位到目前的「模擬時點」
const hoverI = ref(null);
const idx = computed(() => {
  const {days} = model.value;
  let i = hoverI.value;
  if(i == null){
    const from = days[0], to = days[days.length - 1];
    i = Math.round((state.tRem - from)/(to - from)*SPARK_N);
  }
  return Math.max(0, Math.min(SPARK_N, i));
});

// 格子裡的大數字只能是一套的；講明是哪一套，其餘的靠曲線與顏色讀
const caption = computed(() => {
  const {days} = model.value;
  return `左＝現在（剩 ${nf(days[0], 0)} 天），右＝到期；游標處：剩 ${nf(days[idx.value], 0)} 天`
    + (isMulti() ? `　數字為${activeCombo().name}，曲線為所有顯示中的組合` : "");
});

const tiles = computed(() => {
  const {views, scales, iAct} = model.value;
  const i = idx.value;
  return GREEK_META.map(m => {
    const sc = scales[m.k];
    return {
      ...m,
      sc,
      value: m.fmt(views[iAct].series[m.k][i]),
      px: sc ? sc.x(i) : 0,
      lines: sc ? views.map(v => ({color:v.color, d:sparkPath(v.series[m.k], sc)})) : [],
      dots: sc ? views.map(v => {
        const val = v.series[m.k][i];
        return isFinite(val) ? {color:v.color, cx:sc.x(i), cy:sc.y(val)} : null;
      }).filter(Boolean) : []
    };
  });
});

function onMove(ev){
  const svg = ev.target.closest(".spark");
  if(!svg){ hoverI.value = null; return; }
  const r = svg.getBoundingClientRect();
  hoverI.value = Math.round((ev.clientX - r.left)/r.width*SPARK_N);
}
</script>

<template>
  <section class="sens">
    <div class="sens-head">
      <p class="eyebrow">部位敏感度隨剩餘天數的變化</p>
      <p class="sens-caption">{{ caption }}</p>
    </div>
    <div class="greeks" @mousemove="onMove" @mouseleave="hoverI = null">
      <div class="greek" v-for="t in tiles" :key="t.k">
        <div class="g">{{ t.g }}</div>
        <div class="n">{{ t.value }}</div>
        <div class="h">{{ t.h }}</div>
        <svg v-if="t.sc" class="spark" :viewBox="`0 0 ${SPARK_W} ${SPARK_H}`" aria-hidden="true">
          <line v-if="t.sc.zero != null" x1="0" :y1="t.sc.zero" :x2="SPARK_W" :y2="t.sc.zero" stroke="var(--ink-3)" stroke-width="1" opacity=".5"/>
          <path v-for="(l, i) in t.lines" :key="i" :d="l.d" fill="none" :stroke="l.color" stroke-width="1.6" stroke-linejoin="round"/>
          <line :x1="t.px" y1="0" :x2="t.px" :y2="SPARK_H" stroke="var(--ink)" stroke-width="1" opacity=".35"/>
          <circle v-for="(d, i) in t.dots" :key="'d'+i" r="3" :cx="d.cx" :cy="d.cy" :fill="d.color" stroke="var(--card)" stroke-width="1.5"/>
        </svg>
        <div v-else class="spark-empty">無資料</div>
      </div>
    </div>
  </section>
</template>
