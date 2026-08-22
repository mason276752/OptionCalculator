<script setup>
import { computed } from "vue";
import { state } from "../lib/state.js";
import { STRATEGIES, applyPreset } from "../lib/strategies.js";

/* 速查表：同一份資料換一個視角，方便橫向比較。
   分類抬頭原本靠 lastCat 逐列比對插進去；改成先分組，模板直接照組別展開。 */
const groups = computed(() => {
  const out = [];
  for(const st of STRATEGIES){
    if(!out.length || out[out.length-1].cat !== st.cat) out.push({cat:st.cat, items:[]});
    out[out.length-1].items.push(st);
  }
  return out;
});

const on = key => state.presets.some(p => p?.k === key);

function pick(key, stack){
  applyPreset(key, stack);
  document.getElementById("stratPanel")?.scrollIntoView({behavior:"smooth", block:"nearest"});
}
</script>

<template>
  <details class="table-wrap">
    <summary>策略速查表（{{ STRATEGIES.length }} 種範本，⚠ 為含裸露腳位或有特殊風險的部位）</summary>
    <div class="scroll-x">
      <table class="strat-table">
        <thead><tr>
          <th>策略</th><th>市場觀點</th><th>現金流</th><th>最大獲利</th><th>最大虧損</th><th></th>
        </tr></thead>
        <tbody>
          <template v-for="g in groups" :key="g.cat">
            <tr class="cat"><td colspan="6">{{ g.cat }}</td></tr>
            <tr v-for="st in g.items" :key="st.key" :class="{on: on(st.key)}">
              <td class="name">{{ st.name }}{{ st.warn ? " ⚠" : "" }}<span class="en">{{ st.en }}</span></td>
              <td>{{ st.view }}</td>
              <td class="num">{{ st.flow }}</td>
              <td class="num">{{ st.maxP }}</td>
              <td class="num">{{ st.maxL }}</td>
              <td class="acts">
                <button class="pick" type="button" @click="pick(st.key, false)">套用</button>
                <button class="pick" type="button" title="保留現有腳位，把這個範本加上去"
                  @click="pick(st.key, true)">＋疊加</button>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <p class="footnote" style="padding:10px 14px">
      最大獲利／最大虧損以「單組部位、持有到期」為準，不含手續費、稅與提前指派；現金流的借記（付出權利金）與貸記（收取權利金）指建倉當下。<br>
      <b>套用</b>會換掉整個部位，<b>＋疊加</b>則是把範本加到現有腳位上。疊加之後這一欄的公式不再適用，實際的最大獲利／虧損／兩平點以策略說明面板與上方摘要的實算值為準。<br>
      每個腳位可以有自己的到期日，所以<b>日曆價差、對角價差、PMCC（窮人的掩護性買權）</b>等跨到期日的策略也能算。這類部位的「到期」指的是<b>最近的那一腳到期的那一天</b>，遠腳在該時點還帶著時間價值，因此到期損益是一條曲線而非折線——上表的公式欄只能寫近似值，實際數字一律以策略說明面板與上方摘要的實算值為準。
    </p>
  </details>
</template>
