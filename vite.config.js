import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// base 用相對路徑：GitHub Pages 可能佈在 /<repo>/ 之下，絕對路徑會抓不到資產。
export default defineConfig({
  base: "./",
  plugins: [vue()],
  // 開發時只從真正的進入點掃相依；根目錄若還放著別的 .html（例如舊版備份），
  // 預掃描會連它一起剖析，既慢又會噴無關的警告。
  optimizeDeps: { entries: ["index.html"] },
  build: {
    outDir: "dist",
    // market.json／chain.json 是 import 進來的（見 src/lib/data.js），
    // 會被打包成 JS 常數，不需要另外複製到輸出目錄。
    assetsInlineLimit: 0,
    // 報價資料每個交易日都會被工作流程更新，程式碼卻幾乎不動。
    // 拆成兩個 chunk，資料換版時瀏覽器仍能沿用快取住的程式碼。
    rollupOptions: {
      output: {
        manualChunks(id){
          if (id.endsWith("chain.json") || id.endsWith("market.json")) return "market-data";
        }
      }
    },
    chunkSizeWarningLimit: 700
  }
});
