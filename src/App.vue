<script setup>
import { computed, watch } from "vue";
import { state, saveState } from "./lib/state.js";
import { analyze } from "./lib/model.js";

import TopBar from "./components/TopBar.vue";
import MarketPanel from "./components/MarketPanel.vue";
import ComboPanel from "./components/ComboPanel.vue";
import LegsPanel from "./components/LegsPanel.vue";
import KpiPanel from "./components/KpiPanel.vue";
import PnlChart from "./components/PnlChart.vue";
import MarginChart from "./components/MarginChart.vue";
import GreeksPanel from "./components/GreeksPanel.vue";
import StrategyPanel from "./components/StrategyPanel.vue";
import StrategyTable from "./components/StrategyTable.vue";
import SolverPanel from "./components/SolverPanel.vue";
import DataTable from "./components/DataTable.vue";

/* 目前選中那一套組合的實算結果。過去 render() 會呼叫一次 analyze() 再把它
   傳給六個 render 函式；這裡換成一個 computed，相依的 state 一動就自己重算，
   底下的元件全部吃同一份，不會各算各的。 */
const a = computed(() => analyze());

// 過去每次 render() 結尾都會 saveState()；改成盯著整份 state，效果一樣
watch(state, saveState, {deep:true, flush:"post"});
</script>

<template>
  <TopBar />

  <div class="layout">
    <aside class="rail">
      <MarketPanel :a="a" />
      <ComboPanel />
      <LegsPanel />
      <div class="block">
        <div class="block-head"><p class="eyebrow">圖表範圍</p></div>
        <div class="field">
          <!-- 中心是「基準價」而不是 state.S：現價滑桿橫移時區間要固定住 -->
          <label for="rangePct">以基準價為中心 ±<span>{{ state.rangePct }}</span>%</label>
          <input type="range" id="rangePct" min="5" max="90" step="5" style="accent-color:var(--accent)"
            :value="state.rangePct" @input="state.rangePct = +$event.target.value">
        </div>
      </div>
    </aside>

    <main class="stage">
      <KpiPanel :a="a" />
      <PnlChart :a="a" />
      <MarginChart :a="a" />
      <GreeksPanel :a="a" />
      <StrategyPanel :a="a" />
      <StrategyTable />
      <SolverPanel />
      <DataTable :a="a" />

      <p class="footnote">
        理論價與希臘字母以 Black–Scholes 模型（含連續股息率）計算，假設波動率固定、可連續避險，不含手續費、稅、股利發放時點與提前履約（美式）價值。實際成交損益會有出入，本工具僅供試算，非投資建議。
      </p>
    </main>
  </div>
</template>
