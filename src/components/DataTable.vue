<script setup>
import { computed } from "vue";
import { state } from "../lib/state.js";
import { expiryPnl, pnlAt } from "../lib/model.js";
import { nf, signedMoney, price, cls } from "../lib/format.js";

const props = defineProps({ a: { type: Object, required: true } });

const view = computed(() => {
  const a = props.a;
  const lo = Math.max(0, state.S*(1 - state.rangePct/100));
  const hi = state.S*(1 + state.rangePct/100);
  const marks = new Map();
  const put = (v, tag) => {
    if(v < lo - 1e-9 || v > hi + 1e-9) return;
    const k = +v.toFixed(4);
    marks.set(k, marks.has(k) ? marks.get(k) + "／" + tag : tag);
  };
  put(lo, "區間下緣"); put(hi, "區間上緣"); put(state.S, "現價");
  a.strikes.forEach(k => put(k, "履約價"));
  a.breakevens.forEach(b => put(b, "兩平"));
  const risk = isFinite(a.maxLoss) ? Math.abs(a.maxLoss) : NaN;

  const rows = [...marks.keys()].sort((x,y)=>x-y).map(S => {
    const e = expiryPnl(S), n = pnlAt(S, state.tRem);
    const ret = isFinite(risk) && risk > 0 ? (e/risk*100) : NaN;
    return {
      S, mark: marks.get(S),
      pct: (S/state.S-1>=0?"+":"−") + nf(Math.abs(S/state.S-1)*100,1) + "%",
      e, n, ret
    };
  });
  return {rows, diagonal:a.diagonal};
});
</script>

<template>
  <details class="table-wrap">
    <summary>數值表（關鍵價位的損益）</summary>
    <div class="scroll-x">
      <table>
        <thead><tr>
          <th>標的價格</th><th>漲跌幅</th>
          <th>{{ view.diagonal ? "近腳到期" : "到期" }}損益</th>
          <th>剩 {{ state.tRem }} 天</th><th>對最大風險</th>
        </tr></thead>
        <tbody>
          <tr v-for="r in view.rows" :key="r.S">
            <td :data-mark="r.mark">{{ price(r.S) }}</td>
            <td>{{ r.pct }}</td>
            <td :class="cls(r.e)">{{ signedMoney(r.e) }}</td>
            <td :class="cls(r.n)">{{ state.tRem > 0 ? signedMoney(r.n) : "—" }}</td>
            <td :class="cls(r.e)">{{ isFinite(r.ret) ? (r.ret>=0?"+":"−") + nf(Math.abs(r.ret),0) + "%" : "—" }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </details>
</template>
