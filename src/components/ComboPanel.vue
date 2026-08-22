<script setup>
import { computed } from "vue";
import {
  state, isMulti, comboPos, comboNeg, comboAcc, SERIES_N
} from "../lib/state.js";
import { addCombo } from "../lib/actions.js";

const multi = computed(() => isMulti());
const full = computed(() => state.combos.length >= SERIES_N);

// 色票的三個階＝這一套在圖上的三條線（到期漲、到期跌、T+n）；
// 只開一套時沿用原本的紅綠藍，畫面與過去完全一樣
const dot = c => multi.value
  ? {"--c": comboAcc(c), "--cp": comboPos(c), "--cn": comboNeg(c)}
  : {"--c": "var(--accent)", "--cp": "var(--pos)", "--cn": "var(--neg)"};

function remove(c){
  if(state.combos.length < 2) return;
  state.combos = state.combos.filter(x => x !== c);
  if(state.active === c.id) state.active = state.combos[0].id;
}
</script>

<template>
  <div class="block">
    <div class="block-head">
      <p class="eyebrow">策略組合</p>
      <button class="btn btn-ghost btn-mono" type="button" :disabled="full" @click="addCombo(null)"
        :title="full
          ? `最多 ${SERIES_N} 套：分類配色只有六階，再多就分不出哪條線是哪一套`
          : '再開一套組合，和現有的疊在同一張圖上比較'">＋ 新增組合</button>
    </div>
    <div class="combos">
      <!-- 點一列＝選這一套；名字欄位幾乎佔滿整列，點它同樣算選取 -->
      <div v-for="c in state.combos" :key="c.id"
        class="combo" :class="{active: c.id === state.active, off: !c.on}"
        @click="state.active = c.id">
        <button class="vis" type="button" :aria-pressed="!!c.on" :style="dot(c)"
          :title="c.on ? '在圖上隱藏這一套' : '在圖上顯示這一套'"
          :aria-label="`${c.on ? '隱藏' : '顯示'} ${c.name}`"
          @click.stop="c.on = !c.on"></button>
        <input class="nm" type="text" maxlength="12" aria-label="組合名稱"
          :value="c.name" @input="c.name = $event.target.value">
        <span class="cnt">{{ c.legs.length }} 腳</span>
        <button class="btn btn-ghost btn-mono" type="button" title="複製這一套當成新的組合"
          :disabled="full" @click.stop="addCombo(c)">複製</button>
        <button class="btn btn-ghost btn-mono" type="button" title="刪除這一套"
          :disabled="state.combos.length < 2" @click.stop="remove(c)">✕</button>
      </div>
    </div>
    <p class="footnote combo-note">
      點一列即可切換要編輯的組合；左邊的圓點切換這條曲線在圖上的顯示與否。
      下方的腳位、摘要、敏感度數字都屬於目前選中的那一套；圖表與敏感度小圖則會同時畫出所有顯示中的組合。
      市場參數（現價、天數、利率、股息、乘數）與模擬時點由各組合共用，比較才有基準。
    </p>
  </div>
</template>
