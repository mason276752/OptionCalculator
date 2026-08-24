<script setup>
import { computed } from "vue";
import { state, isMulti, activeCombo } from "../lib/state.js";
import { capitalBase, greeks, positionValue, pnlAt, requiredMargin, marginDetail, hasShortLeg } from "../lib/model.js";
import { nf, money, signedMoney, price, cls } from "../lib/format.js";

const props = defineProps({ a: { type: Object, required: true } });

const multi = computed(() => isMulti());

// 這八個數字只能描述一套部位；有多套時要講明是哪一套，不然會被讀成全部的合計
const summaryWho = computed(() => multi.value
  ? `目前選中：${activeCombo().name}（共 ${state.combos.length} 套；要看別套請在左欄點它）` : "");

const items = computed(() => {
  const a = props.a;
  const risk = isFinite(a.maxLoss) ? Math.abs(a.maxLoss) : NaN;
  const rr = isFinite(a.maxProfit) && risk > 0 ? a.maxProfit/risk : NaN;
  const nowPnl = pnlAt(state.S, state.tRem);
  const cap = capitalBase(a);
  // 建倉當下的淨現金流；正值＝要掏錢。與 capitalBase() 裡的 debit 同一個定義
  const debit = -a.netPremium + a.stockCost;

  // 公式住在 model.js，保證金曲線圖用的是同一條（見 requiredMargin）
  const hasShort = hasShortLeg();
  const marginAmt = requiredMargin(a);
  const mDetail = marginDetail();
  const notional = greeks().delta * state.S;       // Delta 等值的標的市值
  const lev = cap && cap.amount > 0 ? Math.abs(notional)/cap.amount : NaN;
  // 波動倍數（Omega／Lambda）：標的變動 1%，部位理論現值跟著變動幾 %
  const posVal = positionValue();
  const omega = Math.abs(posVal) > 1e-6 ? Math.abs(notional)/Math.abs(posVal) : NaN;
  // 百分比一律以「資金基準」為分母（買方＝淨支出，賣方＝最大風險約當保證金），
  // 四格用同一把尺才能互相比較。
  const base = cap && cap.amount > 0 ? cap.amount : NaN;
  const pct = v => {
    if(!isFinite(v) || !isFinite(base)) return "";
    const p = v/base*100;
    return `<span class="pct">${p >= 0 ? "+" : "−"}${nf(Math.abs(p), Math.abs(p) < 10 ? 1 : 0)}%</span>`;
  };
  const pctNote = isFinite(base)
    ? `百分比以${cap.full} ${money(base)} 為分母。`
      + (cap.estimated ? "此為 Reg-T 基準估算，券商實際收取的保證金可能不同（投資組合保證金通常更低）。" : "")
    : "";

  // 年化：把持有期的總報酬換算成一年。用複利而非乘以 365/天數——
  // 519 天賺 67% 不等於年化 47%，錢在期間內是滾動的。
  const annualized = (v, days) => {
    if(!isFinite(v) || !isFinite(base) || !(days > 0)) return null;
    const growth = 1 + v/base;
    return growth <= 0 ? -100 : (Math.pow(growth, 365/days) - 1)*100;
  };
  const annText = (v, days) => {
    const p = annualized(v, days);
    if(p === null) return "";
    const cap0 = Math.abs(p) >= 1000 ? nf(p/100, 1) + " 倍" : nf(Math.abs(p), Math.abs(p) < 10 ? 1 : 0) + "%";
    return `年化 ${p >= 0 ? "+" : "−"}${cap0}`;
  };
  const elapsed = Math.max(0, state.dte - state.tRem);

  // 時間耗損：把標的價固定在現值，只讓日子走完，部位理論價會少掉多少。
  // 這等於「目前手上還沒流失的時間價值」，買方為負（要付出去），賣方為正（收下來）。
  const valNow = positionValue(state.tRem);
  const decayLeft = positionValue(0) - valNow;               // 從現在抱到近腳到期
  const decaySpent = valNow - positionValue(state.dte);      // 建倉到現在已經耗掉的
  // 跨到期日時，部位時鐘歸零指的是近腳到期，遠腳那天還活著——所有以「到期」
  // 為終點的敘述都得改口，不然會讓人以為時間價值已經全部走完
  const expWord = a.diagonal ? "近腳到期" : "到期";
  const diagNote = a.diagonal
    ? `此部位跨到期日：這裡的終點是近腳到期（${state.dte} 天），遠腳當天仍有時間價值，未計入。`
    : "";

  return [
    {k:"最大獲利", v:money(a.maxProfit) + pct(a.maxProfit), c:isFinite(a.maxProfit) ? cls(a.maxProfit) : "pos",
     s:isFinite(a.maxProfit) ? annText(a.maxProfit, state.dte) : "標的續漲無上限",
     t:pctNote + `年化以持有至${expWord}（${state.dte} 天）複利換算。` + diagNote},
    {k:"最大虧損", v:money(a.maxLoss) + pct(a.maxLoss), c:isFinite(a.maxLoss) ? cls(a.maxLoss) : "neg",
     s:isFinite(a.maxLoss) ? annText(a.maxLoss, state.dte) : "風險無上限",
     t:pctNote + `年化以持有至${expWord}（${state.dte} 天）複利換算。` + diagNote
       + (isFinite(a.maxLoss) && Math.abs(a.maxLoss + base) < 0.5
        ? "　買方部位的最大虧損就是投入的權利金，所以必然是 −100%。" : "")},
    {k:"損益兩平",
     v:a.breakevens.length
        ? a.breakevens.map(b => `<span class="n">${price(b)}</span>`).join('<span class="sep"> · </span>')
        : "—",
     c:a.breakevens.length > 1 ? "compact" : "",
     s:a.breakevens.length
        ? a.breakevens.map(b => (b/state.S-1>=0?"+":"−") + nf(Math.abs(b/state.S-1)*100,1) + "%").join(" · ")
        : "全區間同方向"},
    {k:"淨權利金", v:signedMoney(a.netPremium) + pct(a.netPremium), c:cls(a.netPremium),
     s:a.netPremium >= 0 ? "淨收取（賣方）" : "淨支付（買方）", t:pctNote},
    /* 淨權利金只算選擇權腳，所以掩護性買權那類部位會顯示「淨收取」，
       但你其實得先掏錢買現股。這一格才是「現在要準備多少錢」的答案。 */
    {k:"建倉支出", v:debit > 1e-9 ? money(debit) : debit < -1e-9 ? "倒收 " + money(-debit) : "0", c:"",
     s:[
       Math.abs(a.stockCost) > 0.005
         ? `權利金 ${signedMoney(a.netPremium)}　現股 ${money(a.stockCost)}`
         : "全額為選擇權權利金",
       // 風險無上限的部位，真正卡住帳戶的是保證金而不是這筆現金
       cap && cap.estimated ? `另需保證金 ${money(cap.amount)}（估）` : ""
     ].filter(Boolean).join("　"),
     t:`建倉當下的淨現金流：買進腳付出的權利金與現股成本，減掉賣出腳收取的權利金。`
       + `不含手續費、稅與買賣價差。`
       + (cap && cap.estimated
          ? `此部位風險無上限，除了這筆現金還要壓保證金（小字為 Reg-T 估算，券商實收可能不同）。`
          : "")},
    {k:"所需保證金", v:hasShort ? money(marginAmt) : "—", c:"",
     /* 只有裸露腳與放空現股會吃標的價格；兩者都沒有就是價差擔保，鐵定水平。
        不寫死「隨標的變動」——裸露賣權在深價外時下限會咬住，那一段其實也是平的，
        實際會不會動看下方那張圖。 */
     s:!hasShort ? "買方部位，全額付現"
       : marginAmt < 0.005 ? "賣出腳已有掩護，不另佔保證金"
       : mDetail.naked > 0 && mDetail.shortStock > 0
         ? `含 ${mDetail.naked} 口裸露腳與放空現股`
       : mDetail.naked > 0 ? `含 ${mDetail.naked} 口裸露腳，走 Reg-T`
       : mDetail.shortStock > 0 ? "放空現股，Reg-T 收 50%"
       : "價差擔保，不隨標的變動",
     t:`帳戶為了這個部位必須壓住的資金。先判斷每條賣出腳有沒有被掩護：`
       + `現股掩護的（掩護性買權）不另外要求；被買進腳擋住的收兩履約價的價差寬度；`
       + `什麼都沒擋的才走 Reg-T 裸賣公式——那條公式吃標的價格，所以只有這種部位的保證金會隨標的膨脹。`
       + `兩側取較大的一邊（標的只會落在一邊）；兩邊都有裸露腳時再加計另一邊的權利金。`
       + `放空現股另計 50%。`
       + `最後與「最壞情況擔保」取低者——不必為一個最多賠 X 的部位壓超過 X 的錢。`
       + `一律為 Reg-T 基準，券商的投資組合保證金通常更低；台指選擇權用 SPAN，公式完全不同。`},
    {k:"報酬風險比", v:isFinite(rr) ? nf(rr,2) + "×" : "—", c:"",
     s:!isFinite(risk) ? "風險無上限" : !isFinite(a.maxProfit) ? "獲利無上限，無法計比"
        : "以最大風險 " + money(risk) + " 計"},
    {k:"曝險金額", v:signedMoney(notional), c:"",
     s:cap ? `${cap.short} ${money(cap.amount)}${cap.estimated ? "（估）" : ""}` : "無法估算保證金",
     t:`Delta 等值的標的市值；為負代表空方部位。槓桿與波動倍數的走勢見下方敏感度區。`},
    {k:"時間耗損", v:signedMoney(decayLeft) + pct(decayLeft), c:cls(decayLeft),
     s:state.tRem > 0
        ? `平均每天 ${signedMoney(decayLeft/state.tRem)}`
          + (elapsed >= 1 ? `　已耗 ${signedMoney(decaySpent)}` : "")
        : a.diagonal ? "近腳已到期，遠腳仍有時間價值" : "已到期，時間價值歸零",
     t:pctNote + `標的固定在 ${price(state.S)}，把剩下的 ${state.tRem} 天走完，`
       + `部位理論價會變動的金額`
       + (a.diagonal
          ? `。跨到期日部位走到的是近腳到期日，遠腳當天還沒到期，`
            + `所以這個數字是「近腳全額 ＋ 遠腳這段期間」的耗損，不是全部的時間價值。`
          : `——也就是目前尚未流失的時間價值總額。`)
       + `買方為負（付出去），賣方為正（收下來）。`
       + (elapsed >= 1 ? `建倉至今（${elapsed} 天）已耗損 ${signedMoney(decaySpent)}，同樣以現在的標的價計算。` : "")
       + `逐日的累計曲線見下方敏感度區的「累計耗損」。`},
    {k:"目前損益", v:signedMoney(nowPnl) + pct(nowPnl), c:cls(nowPnl),
     // 年化要用「已經過去的天數」當持有期；剛建倉時分母為零，年化沒有意義
     s:elapsed >= 1 ? `${annText(nowPnl, elapsed)}（已過 ${elapsed} 天）` : `剛建倉，尚無持有期`,
     t:pctNote + `標的 ${price(state.S)}，剩 ${state.tRem} 天。年化以已持有 ${elapsed} 天複利換算。`}
  ];
});
</script>

<template>
  <section class="sens">
    <div class="sens-head" v-if="multi">
      <p class="eyebrow">部位摘要</p>
      <p class="sens-caption">{{ summaryWho }}</p>
    </div>
    <div class="kpis">
      <!-- v 是由數字組出來的小段 HTML（兩平點的多個數字、百分比的小字），
           內容全部來自 money()／price() 的輸出，沒有使用者輸入的原字串 -->
      <div class="kpi" v-for="i in items" :key="i.k" :title="i.t || null">
        <span class="k">{{ i.k }}</span>
        <span class="v" :class="i.c" v-html="i.v"></span>
        <span class="s">{{ i.s || " " }}</span>
      </div>
    </div>
  </section>
</template>
