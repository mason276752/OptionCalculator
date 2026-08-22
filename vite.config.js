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
    assetsInlineLimit: 0
  }
});
