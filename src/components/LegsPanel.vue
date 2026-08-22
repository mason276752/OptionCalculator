<script setup>
import { computed, reactive } from "vue";
import { LABEL } from "../lib/data.js";
import { bs, impliedVol } from "../lib/bs.js";
import { state, isMulti, activeCombo, nextLegId } from "../lib/state.js";
import { yearsLeft, legDte, legRem, legValue, legIv, ivShift } from "../lib/model.js";
import { intrinsicOf, chainQuote, listedStep, applyChainQuote } from "../lib/quotes.js";
import { roundStrike, unlinkLeg, clearPreset } from "../lib/strategies.js";
import { onNum } from "../lib/actions.js";
import { nf, price, expiryLabel } from "../lib/format.js";

const legsWho = computed(() => isMulti() ? `（${activeCombo().name}）` : "");

/* 一列腳位要顯示的東西一次算齊：理論價、價值拆解、鏈上報價、履約價微調級距。
   同一個腳位的這幾項彼此相關，分開在模板裡各叫一次會把 legValue() 重算好幾遍。 */
const view = computed(() => state.legs.map(leg => {
  const theo = leg.type === "stock" ? null : legValue(leg, state.S, state.tRem);
  const d = legDte(leg);
  return {
    leg, theo, d, gap: d - state.dte,
    split: leg.type === "stock" ? null : splitText(leg, theo),
    quote: quoteOf(leg),
    step: listedStep(leg)
  };
}));

function splitText(leg, theo){
  const iv0 = intrinsicOf(leg, state.S);
  const tv = theo - iv0;
  const eff = legIv(leg, state.tRem), base = leg.iv ?? state.iv;
  const ivNote = Math.abs(eff - base) >= 0.05 ? `　IV ${nf(eff,1)}%` : "";
  const moneyness = leg.type === "call"
    ? (state.S > leg.K ? "價內" : state.S < leg.K ? "價外" : "價平")
    : (state.S < leg.K ? "價內" : state.S > leg.K ? "價外" : "價平");
  return {moneyness, iv0, tv, ivNote};
}

// 永遠把快照市價攤在腳位上。偏離超過 5% 就標紅——
// 靜靜地用一個對不上市場的權利金往下算，是最容易讓人誤判的失效方式。
function quoteOf(leg){
  const qt = chainQuote(leg);
  if(!qt) return null;
  const off = Math.abs(leg.premium - qt.mid)/Math.max(qt.mid, 0.01);
  return {...qt, stale: off > 0.05 || Math.abs(qt.K - leg.K) > 1e-9};
}

/* 按鈕按下去沒東西可算時（無報價／無解）就地把字換掉再換回來，
   比彈一個對話框安靜，也不必另外找地方放錯誤訊息。 */
const flash = reactive({});
function flashBtn(key, text, ms = 1200){
  flash[key] = text;
  setTimeout(() => { delete flash[key]; }, ms);
}

/* 微調履約價時要知道「這次編輯之前是哪一檔」：階梯間距大於微調幅度時，
   最接近的結果就是原本那一檔，沒有這個基準就永遠推不動（見 applyChainQuote）。 */
const pendingK = {};

function onK(ev, leg){
  onNum(ev, v => {
    if(pendingK[leg.id] == null) pendingK[leg.id] = leg.K;
    leg.K = v;
  });
}
// 用 change 而非 input：打字過程中不打擾，離開欄位才吸附
function snapK(leg){
  const prevK = pendingK[leg.id];
  delete pendingK[leg.id];
  applyChainQuote(leg, prevK ?? null);
}

function setType(leg, v){
  leg.type = v;
  if(leg.type === "stock"){ leg.qty = Math.max(1, leg.qty*state.mult); leg.premium = state.S; }
  unlinkLeg(leg);
}

function toggleSide(leg){ leg.side = -leg.side; unlinkLeg(leg); }

function removeLeg(leg){
  unlinkLeg(leg);
  state.legs = state.legs.filter(l => l !== leg);
}

function useQuote(leg){
  if(!applyChainQuote(leg)) flashBtn(leg.id + ":q", "無報價");
}
function useTheo(leg){
  leg.premium = +legValue(leg, state.S, state.tRem).toFixed(2);
}
function solveIv(leg){
  // 兩顆按鈕都要用這一腳自己的剩餘天數，不是部位時鐘的
  const rem = legRem(leg, state.tRem);
  const v = impliedVol(leg.type, state.S, leg.K, yearsLeft(rem), state.r/100, state.q/100, leg.premium);
  if(v === null){ flashBtn(leg.id + ":iv", "無解"); return; }
  // 解出來的是「這一腳現在剩 rem 天」當下的 IV；
  // 扣掉相對它自己到期日的期間結構位移，才是要存進欄位的錨點值
  leg.iv = +(v*100 - ivShift(rem, legDte(leg))).toFixed(1);
}

function addLeg(type){
  state.legs.push(type === "stock"
    ? {id:nextLegId(), type:"stock", side:1, K:0, premium:+state.S.toFixed(2), qty:state.mult, iv:state.iv}
    : {id:nextLegId(), type, side:1, K:+roundStrike(state.S).toFixed(2), qty:1, iv:state.iv,
       premium:+bs(type, state.S, roundStrike(state.S), yearsLeft(state.dte), state.r/100, state.q/100, state.iv/100).price.toFixed(2)});
  // 手動加的腳位不屬於任何範本；說明面板會自動轉成「範本＋手動腳位」的組合視角
}

function clearLegs(){
  state.legs = [];
  clearPreset();
}
</script>

<template>
  <div class="block">
    <div class="block-head">
      <p class="eyebrow">部位腳位 <span class="unit">{{ legsWho }}</span></p>
      <button class="btn btn-ghost btn-mono" @click="clearLegs">全部清除</button>
    </div>
    <div class="legs">
      <div class="leg" v-for="{ leg, theo, d, gap, split, quote, step } in view" :key="leg.id">
        <div class="leg-top">
          <button class="side" :data-side="leg.side" @click="toggleSide(leg)">
            {{ leg.side === 1 ? "買進" : "賣出" }}
          </button>
          <select :value="leg.type" @change="setType(leg, $event.target.value)">
            <option v-for="(t, v) in LABEL" :key="v" :value="v">{{ t }}</option>
          </select>
          <button class="btn btn-ghost" aria-label="刪除此腳位" @click="removeLeg(leg)">✕</button>
        </div>

        <div class="grid-2">
          <div class="field" v-if="leg.type !== 'stock'">
            <label>履約價</label>
            <input type="number" min="0" :step="step"
              :value="leg.K" @input="onK($event, leg)" @change="snapK(leg)">
          </div>
          <div class="field">
            <label>{{ leg.type === "stock" ? "進場價" : "權利金" }}</label>
            <input type="number" step="0.01" min="0"
              :value="leg.premium" @input="onNum($event, v => leg.premium = v)">
          </div>
          <div class="field">
            <label>{{ leg.type === "stock" ? "股數" : "口數" }}</label>
            <input type="number" step="1" min="1"
              :value="leg.qty" @input="onNum($event, v => leg.qty = v)">
          </div>
          <template v-if="leg.type !== 'stock'">
            <div class="field">
              <label>IV %</label>
              <input type="number" step="0.5" min="0.1"
                :value="leg.iv ?? state.iv" @input="onNum($event, v => leg.iv = v)">
            </div>
            <div class="field wide">
              <label>這一腳的到期天數 <span class="unit">{{ expiryLabel(d, gap) }}</span></label>
              <!-- 到期日只能是整天；小於部位時鐘的值照樣存起來，由 legDte() 在讀取時夾住，
                   這樣使用者把全域天數調回來時原本填的值還在 -->
              <input type="number" step="1" :min="state.dte" :value="d"
                @input="onNum($event, v => leg.dte = Math.max(0, Math.round(v)))">
            </div>
          </template>
        </div>

        <template v-if="leg.type !== 'stock'">
          <div class="leg-note">
            <span>理論價 {{ price(theo) }}</span>
            <span class="acts">
              <button class="btn btn-ghost btn-mono" @click="useTheo(leg)">帶入理論價</button>
              <button class="btn btn-ghost btn-mono" @click="solveIv(leg)">
                {{ flash[leg.id + ":iv"] ?? "反推 IV" }}
              </button>
            </span>
          </div>
          <div class="leg-note sub">
            <span><b>{{ split.moneyness }}</b>　內含 {{ price(split.iv0) }}　時間 {{ price(split.tv) }}{{ split.ivNote }}</span>
          </div>
          <div class="leg-note sub" v-if="quote" :class="{'warn-row': quote.stale}">
            <span>市價 {{ price(quote.mid) }}　K {{ price(quote.K) }}　IV {{ nf(quote.iv, 1) }}%</span>
            <span class="acts">
              <button class="btn btn-ghost btn-mono" @click="useQuote(leg)">
                {{ flash[leg.id + ":q"] ?? "套用市價" }}
              </button>
            </span>
          </div>
        </template>
      </div>
    </div>
    <div class="add-row">
      <button class="btn" @click="addLeg('call')">＋ 買權</button>
      <button class="btn" @click="addLeg('put')">＋ 賣權</button>
      <button class="btn" @click="addLeg('stock')">＋ 標的</button>
    </div>
  </div>
</template>
