<script setup>
import { computed, reactive, watch } from "vue";
import { daysTo } from "../lib/data.js";
import { state, src, nextLegId, nextGroupId } from "../lib/state.js";
import { solveExposure, SOL_DELTA_MIN, SOL_DELTA_MAX, SOL_MAX_ROWS, SOL_FIT } from "../lib/solver.js";
import { nf, money, signedMoney, price, cls } from "../lib/format.js";

/* 四個輸入過去是直接讀 DOM 的；換成一份表單狀態，solveExposure() 收同樣那四個值。 */
const form = reactive({target:"", expiry:"", type:"call", budget:""});

const hasChain = computed(() => !!src.chain.expiries?.length);

/* 換標的等於換一整條鏈：到期日清單與現價都不同，預設值得整組重設。
   預設抓「一口價平合約的等值曝險」當起點，數量級才不會離譜。 */
watch(() => src.chain, chain => {
  if(!chain.expiries?.length) return;
  const match = chain.expiries.find(x => x.e === src.market.expiry);
  form.expiry = match ? match.e : chain.expiries[0].e;
  form.target = Math.max(10000, Math.round(chain.spot*state.mult/10000)*10000);
}, {immediate:true});

const view = computed(() => {
  if(!hasChain.value) return null;
  const {rows, ex, dte, target} = solveExposure(form);
  if(!ex) return null;
  if(!rows.length){
    return {rows:[], shown:[], note: target
      ? "這個到期日沒有符合條件的履約價，試著放寬預算上限。"
      : "填入目標曝險金額後會列出候選履約價。", plain:true};
  }

  // 代表點只從真正打得中目標的列裡挑，否則會推薦一個超標七成的部位
  const fitting = rows.filter(x => x.err <= SOL_FIT);
  const pool = fitting.length ? fitting : rows;
  const near = (pick, t) => pool.reduce((a, b) => Math.abs(pick(b) - t) < Math.abs(pick(a) - t) ? b : a);
  const atmRow   = near(x => Math.abs(x.delta), 0.5);
  const cheapest = pool.reduce((a, b) => b.cost < a.cost ? b : a);
  const steady   = pool.reduce((a, b) => b.carry < a.carry ? b : a);
  const tagOf = x => x === atmRow ? "接近價平" : x === cheapest ? "成本最低" : x === steady ? "耗損最低" : "";

  // 抽樣，讓 Delta 區間均勻呈現而不是刷出上百列；三個代表點一定保留
  let shown = rows;
  if(rows.length > SOL_MAX_ROWS){
    const step = (rows.length - 1)/(SOL_MAX_ROWS - 1);
    const idx = new Set([...Array(SOL_MAX_ROWS)].map((_, i) => Math.round(i*step)));
    for(const x of [atmRow, cheapest, steady]) idx.add(rows.indexOf(x));
    shown = [...idx].sort((a, b) => a - b).map(i => rows[i]);
  }

  const note = `以 ${src.chain.symbol} 報價快照計算：現價 ${price(src.chain.spot)}，`
    + `到期 ${ex.e}（剩 ${dte} 天），利率 ${ex.r}%、股息 ${ex.q}%。`
    + `每個履約價的 IV 都由它自己的市場中價反解，已反映波動率偏斜。`
    + `只列 Delta ${SOL_DELTA_MIN}–${SOL_DELTA_MAX} 之間、共 ${rows.length} 個履約價`
    + (shown.length < rows.length ? `，均勻取樣顯示 ${shown.length} 個。` : "。")
    + (fitting.length
        ? `口數只能取整數，因此「誤差」欄超過 ±${SOL_FIT*100}% 的列已淡化，也不列入代表點。`
        : `<b>目標曝險比任何一個履約價買一口的曝險都小</b>，`
          + `整張表最少都得買一口、必然超標。想降低曝險，改選 Delta 更低的到期日或直接調高目標。`)
    + `「每日耗損」是當下的速度（Theta ÷ 成本），「到期耗損」則是抱到到期會被時間吃光的總額`
    + `——也就是現在付出去的時間價值，旁邊的小字是它佔總成本的比重。`;

  return {
    rows, note, plain:false, ex, dte,
    shown: shown.map(x => ({...x, tag:tagOf(x), miss:x.err > SOL_FIT}))
  };
});

function apply(x){
  const {ex, dte} = view.value;
  const cp = form.type;
  state.S = src.chain.spot;
  state.dte = state.tRem = dte;
  state.r = ex.r; state.q = ex.q; state.iv = x.iv;
  const g = nextGroupId();
  state.legs = [{id:nextLegId(), type:cp, side:1, K:x.K, premium:x.mid, qty:x.qty, iv:x.iv, g}];
  state.presets = [{k:cp === "call" ? "long-call" : "long-put", g}];
  document.querySelector(".stage")?.scrollIntoView({behavior:"smooth", block:"start"});
}
</script>

<template>
  <details class="table-wrap" v-if="hasChain">
    <summary>曝險試算：我要多少曝險，該買哪個履約價</summary>
    <div class="solver-controls">
      <div class="field">
        <label for="solTarget">目標曝險金額</label>
        <input type="number" id="solTarget" step="1000" min="1" v-model="form.target">
      </div>
      <div class="field">
        <label for="solExpiry">到期日</label>
        <select id="solExpiry" v-model="form.expiry">
          <option v-for="x in src.chain.expiries" :key="x.e" :value="x.e">
            {{ x.e }}（剩 {{ daysTo(x.e) }} 天）
          </option>
        </select>
      </div>
      <div class="field">
        <label for="solType">型態</label>
        <select id="solType" v-model="form.type">
          <option value="call">買進買權（作多）</option>
          <option value="put">買進賣權（作空）</option>
        </select>
      </div>
      <div class="field">
        <label for="solBudget">預算上限（可留空）</label>
        <input type="number" id="solBudget" step="1000" min="0" v-model="form.budget">
      </div>
    </div>
    <!-- note 只含本檔組出來的說明字串與數字，沒有使用者輸入的原字串 -->
    <p class="footnote solver-note" v-if="view" v-html="view.note"></p>
    <div class="scroll-x" v-if="view && !view.plain">
      <table>
        <thead><tr>
          <th>履約價</th><th>合約價</th><th>IV</th><th>Delta</th><th>口數</th>
          <th>實際曝險</th><th>誤差</th><th>總成本</th><th>槓桿</th><th>每日耗損</th><th>到期耗損</th><th>OI</th><th></th>
        </tr></thead>
        <tbody>
          <tr v-for="x in view.shown" :key="x.K" :class="{pick: !!x.tag, miss: x.miss}">
            <td><span class="tag" v-if="x.tag">{{ x.tag }}</span>{{ price(x.K) }}</td>
            <td>{{ nf(x.mid,2) }}</td>
            <td>{{ nf(x.iv,1) }}%</td>
            <td>{{ nf(x.delta,3) }}</td>
            <td>{{ x.qty }}</td>
            <td>{{ signedMoney(x.exposure) }}</td>
            <td :class="{neg: x.miss}">{{ (x.dev >= 0 ? "+" : "−") + nf(Math.abs(x.dev)*100,0) }}%</td>
            <td>{{ money(x.cost) }}</td>
            <td>{{ nf(x.lev,2) }}×</td>
            <td>{{ nf(x.carry,2) }}%</td>
            <td :class="cls(x.decay)">{{ signedMoney(x.decay) }}<span class="sub-n">{{ nf(x.decayPct,0) }}%</span></td>
            <td>{{ nf(x.oi,0) }}</td>
            <td><button class="apply" @click="apply(x)">套用</button></td>
          </tr>
        </tbody>
      </table>
    </div>
  </details>
</template>
