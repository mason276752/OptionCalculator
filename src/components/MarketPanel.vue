<script setup>
import { computed, ref } from "vue";
import { SYMBOLS, daysTo } from "../lib/data.js";
import { state, src } from "../lib/state.js";
import { ivTermAt, ivShift } from "../lib/model.js";
import { repriceLegsFrom } from "../lib/quotes.js";
import { onNum, applySymbol, setSpot } from "../lib/actions.js";
import { dateAfter, nf } from "../lib/format.js";

const props = defineProps({ a: { type: Object, required: true } });

const LEV = {QLD:"2×", TQQQ:"3×", SSO:"2×", SPXL:"3×"};
const hasSymbols = SYMBOLS.length >= 2;
const hasChain = computed(() => !!src.chain.expiries?.length);
const hasTerm = computed(() => !!src.chain.term?.length);

// 跨到期日時要講清楚這個天數指的是誰：圖上的「到期」線畫的就是近腳到期那天
const expDate = computed(() =>
  "（" + dateAfter(state.dte) + (props.a.diagonal ? "　近腳" : "") + "）");

const dataNote = computed(() => {
  const m = src.market;
  return m.asOf
    ? `內建預設值＝${m.symbol} ${m.asOf.replace("T", " ").slice(0, 16)} 報價快照`
      + `（CBOE 延遲報價，非即時）。盤中價格會偏離，實單請以券商報價為準。`
    : "";
});

const ivTermHint = computed(() => {
  const shift = ivShift(state.tRem);
  return !state.ivTerm ? "（已關閉，IV 固定）"
    : Math.abs(shift) < 0.05 ? "（目前為到期日原值）"
    : `（剩 ${state.tRem} 天處 ${shift > 0 ? "+" : "−"}${nf(Math.abs(shift), 1)} 個百分點）`;
});

function onDte(ev){
  onNum(ev, v => {
    const prevDte = state.dte;
    state.dte = v;
    state.tRem = (state.tRem >= prevDte || state.tRem > v) ? v : state.tRem;
  });
}

/* ---- 到期日選單 ----
   換到期日不只是換天數：利率、股息、每個履約價的報價與 IV 都是該到期日專屬的，
   沿用舊值會讓理論價整條偏掉，所以一併換掉。 */
const expiryNote = ref("");
// 目前的天數剛好落在鏈上哪一批合約；對不上就顯示「自訂天數」
const expiryValue = computed(() => {
  const hit = src.chain.expiries?.find(x => daysTo(x.e) === state.dte);
  return hit ? hit.e : "";
});
function onExpiry(ev){
  const ex = src.chain.expiries.find(x => x.e === ev.target.value);
  if(!ex) return;                        // 選「自訂天數」時不動任何值
  state.dte = state.tRem = daysTo(ex.e);
  state.r = ex.r;
  state.q = ex.q;
  // 預設 IV 也要跟著到期日走。它是新增腳位與策略範本的取值來源，
  // 留著長天期 LEAPS 的 IV 去建近月部位，權利金會整個歪掉。
  const atmIv = ivTermAt(state.dte);
  if(atmIv != null) state.iv = +atmIv.toFixed(2);
  const missed = repriceLegsFrom(ex);
  expiryNote.value = missed.length
    ? `這個到期日沒有履約價 ${missed.join("、")} 的報價，該腳位的權利金與 IV 維持原值，理論價會對不上。`
    : "";
}

// 每個腳位有自己的 IV，改預設值不會回頭動它們；這顆按鈕就是那個「回頭動」的動作
const ivToAllText = ref("套用到所有腳位");
function ivToAll(){
  let n = 0;
  for(const leg of state.legs) if(leg.type !== "stock"){ leg.iv = state.iv; n++; }
  ivToAllText.value = n ? `已套用 ${n} 個腳位` : "沒有選擇權腳位";
  setTimeout(() => { ivToAllText.value = "套用到所有腳位"; }, 1500);
}
</script>

<template>
  <div class="block">
    <div class="block-head"><p class="eyebrow">市場參數</p></div>
    <div class="grid-2">
      <div class="field wide" v-if="hasSymbols">
        <label for="symbol">標的</label>
        <select id="symbol" :value="state.symbol" @change="applySymbol($event.target.value)">
          <option v-for="s in SYMBOLS" :key="s" :value="s">
            {{ s }}{{ LEV[s] ? `（${LEV[s]} 槓桿）` : "" }}
          </option>
        </select>
      </div>
      <div class="field">
        <label for="S">標的現價</label>
        <input type="number" id="S" step="0.01" min="0.01"
          :value="state.S" @input="onNum($event, setSpot)">
      </div>
      <div class="field">
        <label for="dte">距到期天數 <span class="unit">{{ expDate }}</span></label>
        <input type="number" id="dte" step="1" min="0" :value="state.dte" @input="onDte">
      </div>
      <div class="field wide" v-if="hasChain">
        <label for="expiryPick">到期日（實際掛出的合約）</label>
        <select id="expiryPick" :value="expiryValue" @change="onExpiry">
          <option value="">自訂天數</option>
          <option v-for="x in src.chain.expiries" :key="x.e" :value="x.e">
            {{ x.e }}（剩 {{ daysTo(x.e) }} 天）
          </option>
        </select>
        <p class="footnote" v-if="expiryNote">{{ expiryNote }}</p>
      </div>
      <div class="field">
        <label for="iv">預設隱含波動率 IV %</label>
        <input type="number" id="iv" step="0.5" min="0.1"
          :value="state.iv" @input="onNum($event, v => state.iv = v)">
        <button class="btn btn-ghost btn-mono" type="button" @click="ivToAll"
          title="把這個值寫進所有既有的選擇權腳位；不按的話只影響之後新增的腳位">{{ ivToAllText }}</button>
      </div>
      <div class="field">
        <label for="mult">合約乘數</label>
        <input type="number" id="mult" step="1" min="1"
          :value="state.mult" @input="onNum($event, v => state.mult = v)">
      </div>
      <div class="field">
        <label for="r">無風險利率 %</label>
        <input type="number" id="r" step="0.05"
          :value="state.r" @input="onNum($event, v => state.r = v)">
      </div>
      <div class="field">
        <label for="q">股息殖利率 %</label>
        <input type="number" id="q" step="0.05"
          :value="state.q" @input="onNum($event, v => state.q = v)">
      </div>
      <div class="field wide">
        <label for="capital">帳戶資金 <span class="unit">（填了才算追繳與歸零價位）</span></label>
        <input type="number" id="capital" step="1000" min="0" placeholder="未設定"
          :value="state.capital || ''" @input="state.capital = Math.max(0, parseFloat($event.target.value) || 0)">
      </div>
    </div>
    <div v-if="hasTerm">
      <label class="check">
        <input type="checkbox" :checked="state.ivTerm" @change="state.ivTerm = $event.target.checked">
        <span>IV 隨剩餘天數沿期間結構變化 <span class="unit">{{ ivTermHint }}</span></span>
      </label>
      <div class="field" style="margin-top:10px">
        <label for="ivSkew">標的移動時的 IV 慣例</label>
        <select id="ivSkew" :value="state.ivSkew" @change="state.ivSkew = $event.target.value">
          <option value="strike">固定履約價（曲面不動）</option>
          <option value="moneyness">固定價性（偏斜跟著標的平移）</option>
        </select>
      </div>
    </div>
    <p class="footnote" style="margin-top:10px">
      美股個股選擇權乘數 100；台指選擇權為 50。<br>
      <span>{{ dataNote }}</span>
    </p>
  </div>
</template>
