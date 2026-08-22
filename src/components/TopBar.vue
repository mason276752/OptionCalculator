<script setup>
import { computed, ref } from "vue";
import { PRESET_GROUPS, applyPreset, stackList } from "../lib/strategies.js";

// 只有「整個部位剛好就是這一個範本」時選單才顯示它；疊加過就退回提示字
const presetValue = computed(() => {
  const list = stackList();
  return list.length === 1 ? list[0].k : "";
});

function onPreset(ev){
  const key = ev.target.value;
  if(!key) return;
  applyPreset(key, false);
  document.getElementById("stratPanel")?.scrollIntoView({behavior:"smooth", block:"nearest"});
}

const ccUs = ref(false);
function toggleCc(){
  const us = document.documentElement.getAttribute("data-cc") === "us";
  document.documentElement.setAttribute("data-cc", us ? "tw" : "us");
  ccUs.value = !us;
}

function toggleTheme(){
  const root = document.documentElement;
  const dark = root.getAttribute("data-theme") === "dark" ||
    (!root.hasAttribute("data-theme") && matchMedia("(prefers-color-scheme: dark)").matches);
  root.setAttribute("data-theme", dark ? "light" : "dark");
}
</script>

<template>
  <header class="topbar">
    <h1 class="brand">LEAPSCALC <span>／ 選擇權損益計算機</span></h1>
    <p class="tagline">輸入現價、履約價、權利金與 IV，看到期與 T+n 的損益曲線</p>
    <div class="spacer"></div>
    <div class="tools">
      <select aria-label="策略範本" style="width:auto" :value="presetValue" @change="onPreset">
        <option value="">套用策略範本…</option>
        <optgroup v-for="g in PRESET_GROUPS" :key="g.cat" :label="g.cat">
          <option v-for="it in g.items" :key="it.key" :value="it.key">{{ it.label }}</option>
        </optgroup>
      </select>
      <button class="btn btn-mono" title="切換漲跌配色" @click="toggleCc">
        {{ ccUs ? "綠漲紅跌" : "紅漲綠跌" }}
      </button>
      <button class="btn btn-mono" title="切換淺色／深色" @click="toggleTheme">◐</button>
    </div>
  </header>
</template>
