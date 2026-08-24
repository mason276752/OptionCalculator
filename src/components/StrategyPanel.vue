<script setup>
import { computed } from "vue";
import { state, isMulti, activeCombo } from "../lib/state.js";
import {
  PRESET_GROUPS, applyPreset, stackList, comboFacts, cashFlowText, netLegParts,
  mergeableCount, dropPresetGroup, mergeDuplicateLegs, clearPreset
} from "../lib/strategies.js";

const props = defineProps({ a: { type: Object, required: true } });

const list = computed(() => stackList());
const who = computed(() => isMulti() ? "／" + activeCombo().name : "");

/* 手動加上、或改到脫離範本的腳位。只要有一腳不屬於範本，範本自己那套
   「最大獲利＝…」就不再描述畫面上的部位，一律改走實算的組合視角。 */
const extra = computed(() =>
  state.legs.filter(l => l.g == null || !list.value.some(x => x.g === l.g)).length);
const solo = computed(() => list.value.length === 1 && !extra.value ? list.value[0].st : null);

const merge = computed(() => mergeableCount());

/* 現金流改用實算值，範本原本那句定性描述降成副標。
   其餘四欄仍是範本的文字：它們講的是「這個結構本來的樣子」，
   實算的最大獲利／虧損就在上方摘要，兩邊各司其職。 */
const soloFacts = computed(() => {
  const s = solo.value;
  return s ? [
    ["市場觀點", s.view], ["建倉組成", s.build],
    ["現金流", cashFlowText(props.a), s.flow],
    ["最大獲利", s.maxP], ["最大虧損", s.maxL]
  ] : [];
});

// 疊加後的風險是相加的，把各組件的風險去重後併成一欄；好處與缺點則可能互相抵觸
// （一個 Theta 為正、一個為負），所以不做合併，改成逐一列出各組件在做什麼。
const risks = computed(() => [...new Set(list.value.flatMap(x => x.st.risks))]);
const warns = computed(() => list.value.filter(x => x.st.warn));
const empty = computed(() => !netLegParts().length);

function onStack(ev){
  const key = ev.target.value;
  ev.target.value = "";
  if(key) applyPreset(key, true);
}
</script>

<template>
  <section class="strat" id="stratPanel" v-if="list.length">
    <div class="strat-head">
      <p class="eyebrow">策略說明 <span>{{ who }}</span></p>
      <p class="strat-title">
        <template v-if="solo">{{ solo.name }}<span class="en">{{ solo.en }}</span></template>
        <template v-else>
          {{ list.map(x => x.st.name).join(" ＋ ") }}
          <span class="en">{{ list.length > 1 ? `疊加 ${list.length} 個範本` : "範本" }}{{ extra ? `＋ ${extra} 個手動腳位` : "" }}</span>
        </template>
      </p>
      <button class="btn btn-ghost btn-mono" type="button" @click="clearPreset">收起</button>
    </div>

    <!-- 堆疊列：每個組件一顆可單獨移除的標籤，後面接著再疊一個的下拉 -->
    <div class="strat-stack">
      <span class="chip" v-for="(x, i) in list" :key="x.g">
        <i class="op" v-if="i">＋</i>{{ x.st.name }}
        <button type="button" :aria-label="`移除 ${x.st.name}`" @click="dropPresetGroup(x.g)">✕</button>
      </span>
      <select class="stack-add" aria-label="疊加策略範本" value="" @change="onStack">
        <option value="">＋ 疊加範本…</option>
        <optgroup v-for="g in PRESET_GROUPS" :key="g.cat" :label="g.cat">
          <option v-for="it in g.items" :key="it.key" :value="it.key">{{ it.label }}</option>
        </optgroup>
      </select>
      <button v-if="merge" class="btn btn-ghost btn-mono" type="button" @click="mergeDuplicateLegs">
        合併重複腳位（{{ merge }}）
      </button>
    </div>

    <div v-if="solo">
      <div class="strat-facts">
        <div v-for="[k, v, note] in soloFacts" :key="k">
          <span class="k">{{ k }}</span>
          <span class="v">{{ v }}<span class="note" v-if="note">{{ note }}</span></span>
        </div>
      </div>
      <p class="strat-goal">{{ solo.goal }}</p>
      <div class="strat-cols">
        <div><h4>好處</h4><ul><li v-for="x in solo.pros" :key="x">{{ x }}</li></ul></div>
        <div><h4>缺點</h4><ul><li v-for="x in solo.cons" :key="x">{{ x }}</li></ul></div>
        <div class="risk"><h4>風險</h4><ul><li v-for="x in solo.risks" :key="x">{{ x }}</li></ul></div>
      </div>
      <p class="warn" v-if="solo.warn">{{ solo.warn }}</p>
      <p class="footnote" style="margin-top:12px">實務提醒：{{ solo.tip }}</p>
    </div>

    <div v-else>
      <div class="strat-facts">
        <div v-for="[k, v] in comboFacts(a)" :key="k">
          <span class="k">{{ k }}</span><span class="v">{{ v }}</span>
        </div>
      </div>
      <p class="strat-goal">
        這是 {{ list.length }} 個範本<template v-if="extra">與 {{ extra }} 個手動腳位</template>疊加出來的部位。
        上面五個數字是<b>整組部位的實算值</b>（由目前腳位直接算出，不是範本的公式），
        圖表、希臘字母與摘要也都已經是合併後的結果。
      </p>
      <p class="warn" v-if="empty">疊加後所有腳位互相抵銷，淨部位為零——損益恆為建倉時的價差。</p>
      <div class="strat-parts">
        <div v-for="x in list" :key="x.g">
          <span class="k">{{ x.st.name }}{{ x.st.warn ? " ⚠" : "" }}</span>
          <span class="v">{{ x.st.goal }}</span>
        </div>
      </div>
      <div class="strat-cols">
        <div class="risk">
          <h4>疊加後的風險（各組件合計）</h4>
          <ul><li v-for="x in risks" :key="x">{{ x }}</li></ul>
        </div>
      </div>
      <p class="warn" v-if="warns.length">
        <template v-for="(x, i) in warns" :key="x.g">
          <br v-if="i">{{ x.st.name }}：{{ x.st.warn }}
        </template>
      </p>
      <p class="footnote" style="margin-top:12px">
        各組件的「好處／缺點」在疊加後可能互相抵銷（例如一腳 Theta 為正、另一腳為負），
        因此不做合併；要看實際的淨效果，請直接看上方數字與下方的敏感度區。
      </p>
    </div>
  </section>
</template>
