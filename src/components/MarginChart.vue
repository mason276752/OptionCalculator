<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import { state, spotAnchor } from "../lib/state.js";
import { requiredMargin, hasShortLeg, legValue } from "../lib/model.js";
import { money, price, nf } from "../lib/format.js";

const props = defineProps({ a: { type: Object, required: true } });

/* 保證金不隨時間變（regTMargin 完全沒有時間項），所以它不屬於上面那組
   「隨剩餘天數變化」的小圖——放進去只會是一條水平線。它真正的變數是標的價格：
   裸賣買權漲三成，Reg-T 保證金差不多翻倍，那才是被迫在最差時點平倉的原因。 */
const H = 132, PAD = {t:14, r:12, b:24, l:64};

const el = ref(null);
const W = ref(760);
let timer;
function measure(){ if(el.value) W.value = Math.max(320, el.value.clientWidth || 760); }
function onResize(){ clearTimeout(timer); timer = setTimeout(measure, 120); }
onMounted(() => { measure(); addEventListener("resize", onResize); });
onBeforeUnmount(() => { clearTimeout(timer); removeEventListener("resize", onResize); });

const view = computed(() => {
  if(!hasShortLeg()) return null;
  const a = props.a;
  // 與損益圖用同一個區間，兩張圖的橫軸才對得起來
  const lo = Math.max(0, spotAnchor.value*(1 - state.rangePct/100));
  const hi = spotAnchor.value*(1 + state.rangePct/100);
  const N = 160;
  const xs = [];
  for(let i = 0; i <= N; i++) xs.push(lo + (hi - lo)*i/N);

  const entry = xs.map(S => requiredMargin(a, S));
  // 重新評價：賣出腳的權利金項改用當下理論價，貼近券商的維持保證金
  const mark  = xs.map(S => requiredMargin(a, S, leg => legValue(leg, S, state.tRem)));
  /* 直接看資料判斷平不平，而不是看最大虧損是否有限：
     賣出腳全部被掩護時（價差、鐵兀鷹、掩護性買權）擔保品就是價差寬度，兩條線重合且水平；
     一旦有裸露腳，Reg-T 那段就會吃標的價格，兩條線也會分岔。 */
  const span = arr => Math.max(...arr) - Math.min(...arr);
  const same = entry.every((v, i) => Math.abs(v - mark[i]) < 1e-6);
  const fixed = same && span(entry) < 1e-6;

  const vals = same ? entry : entry.concat(mark);
  let yLo = Math.min(...vals), yHi = Math.max(...vals);
  if(yHi - yLo < 1e-9){ yLo -= 1; yHi += 1; }
  const pad = (yHi - yLo)*0.18;
  yLo = Math.max(0, yLo - pad); yHi += pad;

  const w = W.value, iw = w - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const x = S => PAD.l + (S - lo)/(hi - lo)*iw;
  const y = v => PAD.t + (yHi - v)/(yHi - yLo)*ih;
  const path = arr => arr.map((v, i) => (i ? "L" : "M") + x(xs[i]).toFixed(1) + " " + y(v).toFixed(1)).join(" ");

  const Snow = Math.min(hi, Math.max(lo, state.S));
  return {
    w, iw, ih, lo, hi, yLo, yHi, x, y, fixed, same,
    dEntry: path(entry), dMark: same ? "" : path(mark),
    nowEntry: requiredMargin(a, state.S),
    nowMark: requiredMargin(a, state.S, leg => legValue(leg, state.S, state.tRem)),
    Snow,
    // 只標三個價位：區間兩端與目前的標的價
    ticks: [lo, hi]
  };
});

const caption = computed(() => {
  const v = view.value;
  if(!v) return "此部位沒有賣出腳，全額付現，不佔保證金。";
  if(v.fixed)
    return `賣出腳全部有掩護：擔保品固定為 ${money(v.nowEntry)}，不隨標的價格變動。`
      + `會隨標的膨脹的是含裸露賣出腳的部位。`;
  return `標的 ${price(state.S)} 時：建倉基準 ${money(v.nowEntry)}`
    + (v.same ? "" : `　重新評價 ${money(v.nowMark)}`)
    + `　（區間 ±${state.rangePct}%，拖動損益圖上的現價倒三角可移動游標）`;
});
</script>

<template>
  <section class="sens">
    <div class="sens-head">
      <p class="eyebrow">所需保證金隨標的價格的變化</p>
      <p class="sens-caption">{{ caption }}</p>
    </div>
    <div class="margin-chart" ref="el">
      <svg v-if="view" :viewBox="`0 0 ${view.w} ${H}`" :height="H" role="img"
        aria-label="所需保證金隨標的價格變化圖">
        <!-- 上下緣與零軸 -->
        <line :x1="PAD.l" :y1="view.y(view.yHi)" :x2="PAD.l + view.iw" :y2="view.y(view.yHi)"
          stroke="var(--grid)" stroke-width="1"/>
        <line :x1="PAD.l" :y1="view.y(view.yLo)" :x2="PAD.l + view.iw" :y2="view.y(view.yLo)"
          stroke="var(--grid)" stroke-width="1"/>
        <text :x="PAD.l - 8" :y="view.y(view.yHi) + 3.5" text-anchor="end"
          font-family="var(--mono)" font-size="10" fill="var(--ink-3)">{{ money(view.yHi) }}</text>
        <text :x="PAD.l - 8" :y="view.y(view.yLo) + 3.5" text-anchor="end"
          font-family="var(--mono)" font-size="10" fill="var(--ink-3)">{{ money(view.yLo) }}</text>

        <!-- 各腳履約價：保證金的轉折都落在這裡 -->
        <line v-for="k in a.strikes.filter(k => k >= view.lo && k <= view.hi)" :key="k"
          :x1="view.x(k)" :y1="PAD.t" :x2="view.x(k)" :y2="PAD.t + view.ih"
          stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="2 4" opacity=".45"/>

        <!-- 重新評價（虛線）先畫，建倉基準（實線）壓在上面 -->
        <path v-if="view.dMark" :d="view.dMark" fill="none" stroke="var(--accent)"
          stroke-width="1.6" stroke-dasharray="5 4" stroke-linejoin="round"/>
        <path :d="view.dEntry" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linejoin="round"/>

        <!-- 目前的標的價 -->
        <line :x1="view.x(view.Snow)" :y1="PAD.t" :x2="view.x(view.Snow)" :y2="PAD.t + view.ih"
          stroke="var(--ink)" stroke-width="1" stroke-dasharray="4 3" opacity=".6"/>
        <circle :cx="view.x(view.Snow)" :cy="view.y(view.nowEntry)" r="4"
          fill="var(--ink)" stroke="var(--card)" stroke-width="2"/>
        <circle v-if="!view.same" :cx="view.x(view.Snow)" :cy="view.y(view.nowMark)" r="3.5"
          fill="var(--accent)" stroke="var(--card)" stroke-width="2"/>

        <text :x="PAD.l" :y="H - 7" font-family="var(--mono)" font-size="10" fill="var(--ink-3)">{{ price(view.lo) }}</text>
        <text :x="PAD.l + view.iw" :y="H - 7" text-anchor="end"
          font-family="var(--mono)" font-size="10" fill="var(--ink-3)">{{ price(view.hi) }}</text>
        <text :x="PAD.l + view.iw" :y="PAD.t - 4" text-anchor="end" font-family="var(--mono)"
          font-size="10" letter-spacing=".1em" fill="var(--ink-3)">標的價格</text>
      </svg>
      <p v-else class="footnote" style="padding:10px 0">
        此部位沒有賣出的選擇權腳：買方全額付現，不佔保證金。
      </p>

      <div class="legend" v-if="view && !view.same">
        <span><i class="swatch" style="background:var(--ink)"></i>建倉權利金基準（與上方摘要一致）</span>
        <span><i class="swatch dash" style="border-top-color:var(--accent)"></i>權利金重新評價（較貼近券商維持保證金）</span>
      </div>
    </div>
    <p class="footnote" v-if="view && !view.same">
      實線是摘要那一格用的公式：Reg-T 的權利金項取<b>建倉權利金</b>。虛線把賣出腳改用<b>當下理論價</b>重新評價，
      標的漲上去時賣出腳本身也變貴，所以更陡——真實的追繳會走在虛線附近。
      兩者都是 Reg-T 基準，券商的投資組合保證金通常更低；台指選擇權用 SPAN，公式完全不同。
    </p>
  </section>
</template>
