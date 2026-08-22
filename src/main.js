import { createApp } from "vue";
import App from "./App.vue";
import { state, loadState } from "./lib/state.js";
import { applySymbol } from "./lib/actions.js";
import "./styles.css";

/* ---- 啟動 ----
   先讀本機（或舊連結）帶進來的設定，再切到它指定的標的。
   reset:false ＝ 照單全收既有部位，只換資料來源，不重建腳位。 */
loadState();
applySymbol(state.symbol, {reset:false});

createApp(App).mount("#app");
