import { bs } from "./bs.js";
import { daysTo } from "./data.js";
import { money, nf, price } from "./format.js";
import { state, src, nextLegId, nextGroupId } from "./state.js";
import { yearsLeft, legDte, ivTermAt } from "./model.js";

/* ---- 策略範本 ---- */
export function strikeStep(S){
  return S >= 2000 ? 100 : S >= 1000 ? 25 : S >= 100 ? 5 : S >= 10 ? 1 : 0.5;
}
export const roundStrike = S => Math.round(S/strikeStep(S))*strikeStep(S);

/* 範本的履約價間距：取「到期前一個標準差」的四分之一，再吸附到履約價級距上。
   固定級距在長天期部位會讓四腳策略的賣出腳全擠在價平——畫出來的鐵兀鷹
   其實是賣出跨式；以波動幅度為尺，範本在近月與 LEAPS 上才會是同一個形狀。
   換算後：垂直價差寬 0.5σ、勒式 ±0.25σ、鐵兀鷹賣出腳 0.5σ、保護腳 1σ。 */
export function presetStep(){
  const grid = strikeStep(state.S);
  const sigma = state.S * (state.iv/100) * Math.sqrt(yearsLeft(state.dte));
  return Math.max(grid, Math.round(sigma*0.25/grid)*grid);
}

/* 把使用者填的 IV 沿著今天觀察到的期間結構平移到目標到期日。
   遠腳不能沿用近腳的 IV：近月 25%、LEAPS 20% 是常態，直接照抄會讓 LEAPS
   的權利金貴上一大截，PMCC 算出來的成本就整個歪掉。與 ivShift() 同一個假設。 */
export function ivAtDte(d){
  if(d === state.dte) return state.iv;
  const here = ivTermAt(d), anchor = ivTermAt(state.dte);
  return here == null || anchor == null ? state.iv : +(state.iv + here - anchor).toFixed(2);
}

/* 跨到期日範本的「遠腳」到期日：鏈上挑最接近一年後、又明顯比近腳遠的那一批；
   沒有鏈資料時退回近腳的四倍。PMCC 的價值全在兩腳的 Theta 落差，
   遠腳不夠遠就只是一個買得很貴的垂直價差。 */
function farDte(){
  const CHAIN = src.chain;
  const want = Math.max(state.dte + 90, 365);
  const cand = (CHAIN.expiries ?? []).map(x => daysTo(x.e)).filter(d => d > state.dte + 20);
  return cand.length
    ? cand.reduce((a, b) => Math.abs(b - want) < Math.abs(a - want) ? b : a)
    : Math.max(Math.round(state.dte*4), state.dte + 90, 180);
}

/* 遠腳要夠價內才像現股（Delta 大約 0.75–0.85）。尺要用遠腳自己的標準差：
   長天期的波動幅度大得多，拿近腳的 σ 去量會遠遠不夠價內。 */
function deepItmStrike(d){
  const sigma = state.S * (ivAtDte(d)/100) * Math.sqrt(yearsLeft(d));
  return roundStrike(Math.max(state.S*0.3, state.S - sigma*0.7));
}

// dte 省略時沿用部位時鐘；只有真的跨到期日的腳位才把 dte 寫進去
function mkLeg(type, side, K, qty, dte){
  const d = dte ?? state.dte;
  const iv = ivAtDte(d);
  const p = type === "stock"
    ? state.S
    : bs(type, state.S, K, yearsLeft(d), state.r/100, state.q/100, iv/100).price;
  const leg = {id:nextLegId(), type, side, K:+K.toFixed(2), premium:+p.toFixed(2), qty, iv};
  if(d !== state.dte) leg.dte = d;
  return leg;
}

/* 每個範本除了腳位怎麼擺，也一起帶著「為什麼要這樣擺」。
   legs 收到的 (s, atm, m) 分別是履約價級距、最接近現價的履約價、合約乘數。
   腳位預設共用部位時鐘的到期日；跨到期日的範本（日曆／對角／PMCC）
   在 mkLeg 的第五個參數指定遠腳自己的天數。 */
export const STRATEGIES = [
  { key:"long-call", cat:"單腳方向性", name:"買進買權", en:"Long Call",
    view:"看多", flow:"借記", maxP:"無上限", maxL:"付出的權利金",
    build:"買進 1 口價平買權",
    legs:(s,atm) => [mkLeg("call", 1, atm, 1)],
    goal:"用一筆有限的權利金換取標的上漲的槓桿曝險。先把下檔鎖死（最多賠光權利金、不會被追繳），再去談上檔。",
    pros:["最大虧損就是付出的權利金，帳戶不會被穿透","資金效率高，一口約當 100 股的曝險","上檔不封頂，Gamma 為正，越漲賺越快"],
    cons:["時間站在對面，每天都在付時間價值（Theta 為負）","買在高 IV 時，方向做對也可能因 IV 收斂而不賺","到期只有價內才有價值，單次勝率天生偏低"],
    risks:["標的原地不動就是慢慢歸零，最後幾週衰減最快","財報等事件後的 IV Crush 會瞬間吃掉權利金","價外太遠的買權看似便宜，實際是低機率彩券"],
    tip:"想降低時間與 IV 的影響，就往價內、往長天期買（LEAPS）；Delta 越接近 1 越像現股。" },

  { key:"long-put", cat:"單腳方向性", name:"買進賣權", en:"Long Put",
    view:"看空", flow:"借記", maxP:"履約價 − 權利金（標的歸零）", maxL:"付出的權利金",
    build:"買進 1 口價平賣權",
    legs:(s,atm) => [mkLeg("put", 1, atm, 1)],
    goal:"押標的下跌，或替持股買下檔保險，而且不必借券放空、沒有被軋空的無限風險。",
    pros:["不用借券，虧損有上限","下跌時 IV 通常同步走高，Vega 與方向同向助攻","可當成持股的保險，不必賣掉現股（免觸發稅務）"],
    cons:["偏斜使價外賣權長期偏貴，成本高","多頭市場中反覆買賣權會被時間價值磨光","急跌後 IV 回落，帳面獲利容易吐回去"],
    risks:["盤整或緩漲就是全額歸零","保護只到到期日，之後要轉倉且屆時可能更貴"],
    tip:"純避險想省錢可改用賣權價差或領口；純看空且要抱久，選長天期減少轉倉摩擦。" },

  { key:"short-put", cat:"單腳方向性", name:"賣出賣權", en:"Cash-Secured Put",
    view:"中性偏多", flow:"貸記", maxP:"收到的權利金", maxL:"履約價 − 權利金（標的歸零）",
    build:"賣出 1 口價外賣權，帳上備妥履約價 × 乘數的現金",
    legs:(s,atm) => [mkLeg("put", -1, atm - s, 1)],
    goal:"你本來就想在更低的價位買這檔股票，那就先收一筆權利金當作等待的報酬。接到貨＝用折價買進，接不到＝純賺權利金。",
    pros:["Theta 為正，時間站在自己這邊","盤整、緩漲、小跌都能賺，單次勝率高","等於「限價買進＋收租」，實際成本＝履約價 − 權利金"],
    cons:["獲利封頂在權利金，是賺小賠大的損益形狀","大漲時只賺那一點點，嚴重落後現股"],
    risks:["崩盤時被指派，滿手套牢股","沒備足現金就是裸賣，波動放大時保證金會膨脹","個股突發利空可能直接跳空穿過履約價"],
    tip:"只對「真的願意持有」的標的賣；賣在 IV 偏高時，履約價常取 Delta 0.2–0.3 附近。" },

  { key:"short-call", cat:"單腳方向性", name:"賣出買權（裸賣）", en:"Naked Call",
    view:"看空／中性", flow:"貸記", maxP:"收到的權利金", maxL:"無上限",
    build:"賣出 1 口價外買權，手上沒有現股掩護",
    legs:(s,atm) => [mkLeg("call", -1, atm + s, 1)],
    goal:"單純收權利金，賭標的漲不過履約價。這是全表中唯一「上檔完全裸露」的單腳部位。",
    pros:["Theta 為正，不動就賺","不必先投入本金（但要壓保證金）","高 IV 時貸記較肥"],
    cons:["風險報酬極不對稱：賺有限、賠無限","保證金隨標的上漲與 IV 升高而膨脹，容易被迫在最差的時點平倉"],
    risks:["軋空、併購消息一根跳空就可能超過帳戶淨值","除息前價內買權可能被提前指派，變成被迫放空現股","券商強制平倉"],
    warn:"高風險：除非有現股掩護（掩護性買權）或上方買了保護腳（空頭買權價差），否則不建議裸賣買權。",
    tip:"把上方加買一口更價外的買權，就變成風險有限的空頭買權價差，代價只是少收一點權利金。" },

  { key:"covered-call", cat:"持股搭配", name:"掩護性買權", en:"Covered Call",
    view:"中性偏多", flow:"貸記（持股成本另計）", maxP:"（履約價 − 持股成本）＋ 權利金", maxL:"持股成本 − 權利金",
    build:"持有 1 個乘數的現股 ＋ 賣出 1 口價外買權",
    legs:(s,atm,m) => [mkLeg("stock", 1, 0, m), mkLeg("call", -1, atm + s, 1)],
    goal:"對已經持有的部位收租：讓出上檔漲幅，換取現金流與一層薄薄的下檔緩衝。",
    pros:["增加現金流、降低持股成本","波動下降、盤整時受惠","整體波動度比純持股低"],
    cons:["上檔被封死，大漲時嚴重落後","下檔保護只有權利金那點厚度，本質仍是多頭部位"],
    risks:["標的暴跌時權利金杯水車薪","被指派＝提前賣出，可能觸發不想要的稅務事件","除息前價內買權有提前指派風險"],
    tip:"履約價選在「真的賣掉也甘願」的價位；IV 偏高時賣，權利金才有意思。" },

  { key:"protective-put", cat:"持股搭配", name:"保護性賣權", en:"Protective Put",
    view:"看多但怕回檔", flow:"借記", maxP:"無上限（扣掉權利金）", maxL:"持股成本 − 履約價 ＋ 權利金",
    build:"持有 1 個乘數的現股 ＋ 買進 1 口價外賣權",
    legs:(s,atm,m) => [mkLeg("stock", 1, 0, m), mkLeg("put", 1, atm - s, 1)],
    goal:"幫持股買保險，把下檔虧損鎖在一個算得出來的數字，同時完整保留上檔。",
    pros:["保留全部上漲空間","虧損有底，大跌時心理與保證金壓力都小","不必為了避險賣掉持股"],
    cons:["保費貴，長期常態買會顯著吃掉報酬","沒事發生時保費就是純成本"],
    risks:["保護只到到期日，轉倉時 IV 可能更貴","自負額＝現價與履約價之間的那段跌幅"],
    tip:"多數人是「保護一段特定期間」（財報、重大事件）而非常態持有；嫌貴就改用領口或賣權價差。" },

  { key:"collar", cat:"持股搭配", name:"領口", en:"Collar",
    view:"保守持有", flow:"接近零成本", maxP:"買權履約價 − 持股成本 − 淨權利金", maxL:"賣權履約價 − 持股成本 − 淨權利金",
    build:"持有現股 ＋ 買進價外賣權 ＋ 賣出價外買權",
    legs:(s,atm,m) => [mkLeg("stock", 1, 0, m), mkLeg("put", 1, atm - s, 1), mkLeg("call", -1, atm + s, 1)],
    goal:"用讓出上檔來支付下檔保險費，把持股的報酬鎖進一個明確區間，常見於鎖利、質押或大額集中持股。",
    pros:["幾乎不花錢就取得下檔保護","報酬區間事先算得清楚","適合抱著大量未實現獲利又不想賣的部位"],
    cons:["上下都被綁住，大漲時完全跟不上","調整（roll）時兩腳都要處理，摩擦成本高"],
    risks:["標的暴衝時買權腳被指派而被迫賣股","長期領口在部分稅制下可能影響持有期間的認定"],
    tip:"想保留多一點上檔，就把買權履約價拉高、接受少量借記成本。" },

  { key:"covered-strangle", cat:"持股搭配", name:"掩護性勒式", en:"Covered Strangle",
    view:"中性偏多，願意再加碼", flow:"貸記（持股成本另計）", maxP:"（買權履約價 − 持股成本）＋ 權利金", maxL:"兩倍持股的下檔虧損",
    build:"持有現股 ＋ 賣出價外買權 ＋ 賣出價外賣權",
    legs:(s,atm,m) => [mkLeg("stock", 1, 0, m), mkLeg("call", -1, atm + 2*s, 1), mkLeg("put", -1, atm - 2*s, 1)],
    goal:"掩護性買權再多賣一腳賣權：上檔讓出、下檔答應在更低的價位再買一手，換來大約兩倍的權利金收入。",
    pros:["權利金約為掩護性買權的兩倍","三種結局都在計畫內：不動收租、漲了賣股、跌了加碼","Theta 為正，盤整期間持續累積"],
    cons:["大跌時等於在下跌途中把曝險加倍","上檔一樣被封頂"],
    risks:["賣權腳被指派後部位變成兩倍持股，虧損也跟著加倍","必須另外準備接股票的現金","除息前價內買權的提前指派"],
    tip:"只在「跌下去真的願意買第二手」時用；賣權履約價就擺在你想加碼的價位。" },

  { key:"stock-repair", cat:"持股搭配", name:"持股修復", en:"Stock Repair",
    view:"已套牢，想降低回本價位", flow:"接近零成本", maxP:"在賣出腳履約價封頂", maxL:"標的續跌的全部損失（與原持股相同）",
    build:"持有現股 ＋ 買進 1 口價平買權 ＋ 賣出 2 口更高履約價買權",
    legs:(s,atm,m) => [mkLeg("stock", 1, 0, m), mkLeg("call", 1, atm, 1), mkLeg("call", -1, atm + 2*s, 2)],
    goal:"被套牢又不想再投錢攤平：用接近零成本的 1×2 買權比例價差，讓標的只要反彈一半就把成本追回來。",
    pros:["幾乎不必再投入資金","反彈區間內的回本速度是持股的兩倍","多賣的那口有現股與買進腳掩護，沒有裸賣風險"],
    cons:["上檔在賣出腳封頂，真的強彈時只能看著","完全不減少下檔虧損"],
    risks:["這是加速回本，不是避險；標的續跌時原有虧損一分不少","到期價內會被指派，現股被賣出"],
    tip:"把左側現股腳的成本價改成你實際的買進成本，圖上才看得到真正的回本點。" },

  { key:"hedge-put-spread", cat:"持股搭配", name:"賣權價差避險", en:"Put Spread Hedge",
    view:"看多但想省避險成本", flow:"借記（低）", maxP:"無上限（扣掉權利金）", maxL:"跌破下方履約價後恢復與持股同步下跌",
    build:"持有現股 ＋ 買進價外賣權 ＋ 賣出更價外賣權",
    legs:(s,atm,m) => [mkLeg("stock", 1, 0, m), mkLeg("put", 1, atm - 2*s, 1), mkLeg("put", -1, atm - 6*s, 1)],
    goal:"保護性賣權太貴時的折衷：只買「第一段跌幅」的保險，把尾部那截保費省下來。",
    pros:["成本遠低於保護性賣權","涵蓋最常發生的中等回檔","上檔完全保留"],
    cons:["保護只有一段，崩盤時會用完","兩腳的交易成本"],
    risks:["跌破下方履約價之後，每一塊錢都跟著賠","保護到期就消失，要重新買"],
    tip:"下方那腳擺在「跌到這裡我就認了」的位置；真的要防崩盤請改用賣權比例逆價差或直接買賣權。" },

  { key:"protective-call", cat:"持股搭配", name:"保護性買權（空單避險）", en:"Protective Call",
    view:"看空，但怕被軋", flow:"借記", maxP:"放空成本 − 權利金（標的歸零）", maxL:"履約價 − 放空成本 ＋ 權利金",
    build:"放空 1 個乘數的現股 ＋ 買進 1 口價外買權",
    legs:(s,atm,m) => [mkLeg("stock", -1, 0, m), mkLeg("call", 1, atm + 2*s, 1)],
    goal:"放空最怕的是無限的上檔；買一口買權把它封起來，換一個抱得住的空單。",
    pros:["把放空的無限風險變成一個固定數字","保證金壓力小很多","下跌獲利幾乎完整保留"],
    cons:["保費會侵蝕空單利潤","借券成本照付"],
    risks:["保護只到到期日","軋空時借券費率飆升、被強制回補的風險仍在","除息由空方支付股息"],
    tip:"空單抱不住多半是因為上檔沒保護；把保費當成停損的替代品來估算划不划算。" },

  /* ---- 跨到期日 ----
     這一組的近腳與遠腳不同月，圖上的「到期」畫的是近腳到期那一天，
     遠腳在那個時點還活著。最大獲利／虧損欄位只能寫近似值：真正的數字取決於
     遠腳當天還剩多少時間價值，那是曲線而不是公式，一律以摘要的實算值為準。 */
  { key:"pmcc", cat:"跨到期日", name:"窮人的掩護性買權", en:"PMCC（Poor Man's Covered Call）",
    view:"緩漲", flow:"借記", maxP:"近似 兩履約價差 − 淨借記 ＋ 遠腳殘值", maxL:"近似 淨借記",
    build:"買進 1 口深價內長天期買權（LEAPS）＋ 賣出 1 口近月價外買權",
    legs:(s,atm) => { const f = farDte();
      // 近腳擺 0.75σ 價外（Delta 約 0.25）：再靠近一點收得多，但履約價差會窄到
      // 撐不住遠腳的成本，標的一漲上去反而是鎖定虧損出場
      return [mkLeg("call", 1, deepItmStrike(f), 1, f), mkLeg("call", -1, atm + 3*s, 1)]; },
    goal:"用一口深價內 LEAPS 取代 100 股現股，再對它賣近月買權收租。掩護性買權的資金效率版：一樣的形狀，佔用的錢少一大截。",
    pros:["建倉成本遠低於買 100 股，同樣的錢能做更多組","近腳每天掉的時間價值比遠腳快得多，淨 Theta 為正","下檔風險封死在淨借記，不像現股會一路跟到底"],
    cons:["遠腳自己也在耗時間價值，行情不動時不是純收租","領不到股息，現股版的掩護性買權領得到","兩腳四趟買賣價差，滾倉成本比現股版高"],
    risks:["標的暴漲時近腳被指派，得平倉或履約遠腳，獲利被鎖在價差寬度內","IV 塌陷對遠腳的傷害遠大於近腳收到的權利金","近腳履約價若低於遠腳履約價＋淨借記，漲上去反而是虧的","遠腳流動性差，想出場時價差很寬"],
    warn:"賣出的近腳履約價必須高於「遠腳履約價 ＋ 淨借記」，否則標的大漲時你是鎖定虧損出場。用本頁把曲線畫出來，看右半邊是不是在零軸上方。",
    tip:"遠腳挑 Delta 0.8 上下、至少 9 個月；近腳挑 30–45 天、Delta 0.2–0.3。改上面兩腳的「到期天數」就能試不同的組合。" },

  { key:"calendar-call", cat:"跨到期日", name:"買權日曆價差", en:"Call Calendar Spread",
    view:"盤整，且遠月 IV 偏低", flow:"借記", maxP:"近似 近腳到期時遠腳的殘值 − 淨借記", maxL:"淨借記",
    build:"賣出 1 口近月價平買權 ＋ 買進 1 口遠月同履約價買權",
    legs:(s,atm) => [mkLeg("call", -1, atm, 1), mkLeg("call", 1, atm, 1, farDte())],
    goal:"同一個履約價、賣近月買遠月，賺的是「近月時間價值掉得比遠月快」這件事本身，跟方向無關。",
    pros:["純粹押注時間衰減的速度差，方向中性","淨 Vega 為正，IV 上升時受益","最大虧損就是淨借記，很小"],
    cons:["獲利區間窄，標的走遠了兩邊都不賺","近腳到期時遠腳值多少沒有公式，只能靠模型估","近月 IV 若高於遠月（逆向期間結構），這個結構就不划算"],
    risks:["近腳被提前指派會把結構打斷，尤其除息前的價內買權","IV 塌陷時遠腳（Vega 大）受傷比近腳收到的多","財報等事件會同時扭曲兩個月份的 IV"],
    tip:"建倉前先看本頁「IV 隨剩餘天數變化」那條期間結構：遠月 IV 明顯低於近月時才值得做。" },

  { key:"diagonal-call", cat:"跨到期日", name:"買權對角價差", en:"Diagonal Call Spread",
    view:"緩漲，且遠月 IV 偏低", flow:"借記", maxP:"近似 兩履約價差 − 淨借記 ＋ 遠腳殘值", maxL:"近似 淨借記",
    build:"賣出 1 口近月價外買權 ＋ 買進 1 口遠月較低履約價買權",
    legs:(s,atm) => [mkLeg("call", -1, atm + 2*s, 1), mkLeg("call", 1, atm - 2*s, 1, farDte())],
    goal:"日曆價差加上方向性：兩腳既不同月也不同履約價，同時收時間價值差與一段上漲空間。PMCC 就是把遠腳推到很價內、很長天期的極端版。",
    pros:["同時吃時間衰減差與方向","比垂直價差多一層 Vega 保護","近腳到期後遠腳還在，可以繼續滾下一個月"],
    cons:["兩個變數（時間差、履約價差）同時動，損益形狀比垂直價差難掌握","成本高於同月的垂直價差"],
    risks:["近腳被指派","IV 期間結構反轉","遠腳流動性"],
    tip:"想看它和 PMCC 的關係，就把遠腳的履約價往下拉、到期天數往後推，曲線會慢慢變成 PMCC 的形狀。" },

  { key:"bull-call", cat:"垂直價差", name:"多頭買權價差", en:"Bull Call Spread（借記）",
    view:"溫和看多", flow:"借記", maxP:"履約價差 − 淨權利金", maxL:"淨權利金",
    build:"買進價平買權 ＋ 賣出更高履約價買權",
    legs:(s,atm) => [mkLeg("call", 1, atm, 1), mkLeg("call", -1, atm + 2*s, 1)],
    goal:"看多但不想付整口買權的錢：賣掉上方的買權補貼成本，代價是放棄更上面的漲幅。",
    pros:["成本與最大虧損都比單買買權低","對時間衰減與 IV 相對鈍感（兩腳部分抵銷）","報酬風險比在建倉時就固定"],
    cons:["獲利封頂","兩腳的手續費與買賣價差加倍","接近到期時中間區域損益變化很鈍，提早了結不划算"],
    risks:["標的沒漲到損益兩平仍會賠光淨權利金","到期日剛好卡在兩履約價之間時，賣出腳被指派、買進腳沒履約，會留下隔夜的單邊部位（pin risk）"],
    tip:"上方那腳擺在自己認定的目標價；價差寬度直接決定賠率。" },

  { key:"bull-put", cat:"垂直價差", name:"多頭賣權價差", en:"Bull Put Spread（貸記）",
    view:"中性偏多", flow:"貸記", maxP:"收到的淨權利金", maxL:"履約價差 − 淨權利金",
    build:"賣出價平／小幅價外賣權 ＋ 買進更低履約價賣權",
    legs:(s,atm) => [mkLeg("put", -1, atm, 1), mkLeg("put", 1, atm - 2*s, 1)],
    goal:"和多頭買權價差同一個損益形狀，但用「收租」的方式建立：時間站在自己這邊，標的不跌就能賺。",
    pros:["Theta 為正，盤整也能賺，勝率高","比裸賣賣權安全，最大虧損固定","佔用的保證金比裸賣少很多"],
    cons:["賺小賠大，一次失手可能吃掉數次獲利","獲利封頂在收到的權利金"],
    risks:["急跌會很快吃到最大虧損","到期日標的卡在賣出腳附近有指派與 pin risk"],
    tip:"適合 IV 偏高、技術面又有支撐時做，把賣出腳放在支撐下方。" },

  { key:"bear-put", cat:"垂直價差", name:"空頭賣權價差", en:"Bear Put Spread（借記）",
    view:"溫和看空", flow:"借記", maxP:"履約價差 − 淨權利金", maxL:"淨權利金",
    build:"買進價平賣權 ＋ 賣出更低履約價賣權",
    legs:(s,atm) => [mkLeg("put", 1, atm, 1), mkLeg("put", -1, atm - 2*s, 1)],
    goal:"看空但要把昂貴的賣權成本壓下來，用賣出下方賣權補貼，放棄跌破那個價位之後的獲利。",
    pros:["成本比單買賣權低，虧損有上限","比放空現股安全：不用借券、沒有無限風險","偏斜讓下方那腳賣得相對貴，補貼效率不錯"],
    cons:["獲利封頂，崩盤時反而覺得少賺","兩腳交易成本"],
    risks:["標的不跌就慢慢歸零","到期卡在兩履約價之間的 pin risk"],
    tip:"事件避險常用它取代單買賣權，因為 IV 已經先被墊高時，價差比較不怕 IV 回落。" },

  { key:"bear-call", cat:"垂直價差", name:"空頭買權價差", en:"Bear Call Spread（貸記）",
    view:"中性偏空", flow:"貸記", maxP:"收到的淨權利金", maxL:"履約價差 − 淨權利金",
    build:"賣出價平／小幅價外買權 ＋ 買進更高履約價買權",
    legs:(s,atm) => [mkLeg("call", -1, atm, 1), mkLeg("call", 1, atm + 2*s, 1)],
    goal:"賭標的漲不上去而收租，同時用上方那口買權把裸賣買權的無限風險封起來。",
    pros:["裸賣買權的安全版，最大虧損固定","Theta 為正，盤整、緩跌都能賺","高 IV 時貸記更肥"],
    cons:["賺小賠大","上漲時因為買權 Delta 加速，很快就吃滿最大虧損"],
    risks:["軋空、利多跳空","價內的賣出腳在除息前可能被提前指派"],
    tip:"賣出腳擺在壓力區上方；別為了多收一點權利金把價差拉得太寬。" },

  { key:"straddle", cat:"做多波動率", name:"買進跨式", en:"Long Straddle",
    view:"中性，但預期大波動", flow:"借記（高）", maxP:"上漲方向無上限", maxL:"兩筆權利金全額",
    build:"同時買進同履約價的價平買權與賣權",
    legs:(s,atm) => [mkLeg("call", 1, atm, 1), mkLeg("put", 1, atm, 1)],
    goal:"不猜方向，只押「會有大行情」——財報、判決、FDA、公投這種結果二元的事件。",
    pros:["漲跌兩邊都能賺，方向猜錯也沒關係","Vega 為正，IV 上升就有帳面獲利","虧損有上限"],
    cons:["全表中最貴的做多波動率方式","需要非常大的幅度才回本，Theta 負得很重"],
    risks:["事件過後 IV Crush：方向做對還倒賠，是財報行情最經典的坑","盤整就是兩邊的時間價值一起融化"],
    tip:"先算損益兩平需要幾 %，再對照這檔標的歷次同類事件的實際波動幅度，划不划算立刻見分曉。" },

  { key:"strangle", cat:"做多波動率", name:"買進勒式", en:"Long Strangle",
    view:"中性，但預期大波動", flow:"借記", maxP:"上漲方向無上限", maxL:"兩筆權利金全額",
    build:"買進價外買權 ＋ 買進價外賣權",
    legs:(s,atm) => [mkLeg("call", 1, atm + s, 1), mkLeg("put", 1, atm - s, 1)],
    goal:"跨式的便宜版：用價外的兩腳降低成本，代價是需要更大的行情才會賺。",
    pros:["建倉成本比跨式低","同樣是雙向、風險有限","IV 上升時彈性大（Vega／成本比高）"],
    cons:["損益兩平的距離更遠，全部歸零的機率比跨式高","價外流動性差、買賣價差吃掉不少"],
    risks:["IV Crush 與時間衰減同時發動","行情雖大但只到一半也可能還是賠"],
    tip:"履約價選得越外，就越接近「買彩券」；用本工具把損益兩平價與你的目標價比一比再下手。" },

  { key:"reverse-iron-condor", cat:"做多波動率", name:"買進鐵兀鷹（反向）", en:"Reverse Iron Condor",
    view:"預期大波動，但要控成本", flow:"借記", maxP:"內外履約價差 − 淨權利金", maxL:"淨權利金",
    build:"買進內側買權與賣權 ＋ 賣出更外側的買權與賣權",
    legs:(s,atm) => [mkLeg("put", -1, atm - 4*s, 1), mkLeg("put", 1, atm - 2*s, 1),
                     mkLeg("call", 1, atm + 2*s, 1), mkLeg("call", -1, atm + 4*s, 1)],
    goal:"勒式的限縮版：賣掉更外側兩腳來補貼成本，換取一個便宜很多的做多波動率部位。",
    pros:["成本遠低於跨式／勒式，最大虧損小","IV 上升有利","賠率明確，適合小注多次的事件交易"],
    cons:["獲利封頂在外側履約價","四腳的手續費與滑價很傷"],
    risks:["行情不夠大就慢慢歸零","多腳部位進出場都要吃買賣價差，流動性差的標的別碰"],
    tip:"外側腳別放太外，否則補貼有限又白白封住獲利。" },

  { key:"strap", cat:"做多波動率", name:"買進偏多跨式", en:"Strap",
    view:"預期大波動，偏向上漲", flow:"借記（高）", maxP:"上漲方向無上限", maxL:"三筆權利金全額",
    build:"買進 2 口價平買權 ＋ 買進 1 口價平賣權",
    legs:(s,atm) => [mkLeg("call", 1, atm, 2), mkLeg("put", 1, atm, 1)],
    goal:"跨式的偏多版：一樣不確定方向，但認為往上的機率與幅度都更大。",
    pros:["上漲時的獲利速度是跨式的兩倍","猜錯方向仍有賣權接手","事件交易中可以用口數表達方向傾向"],
    cons:["三筆權利金，成本與回本門檻都更高","Theta 負得更重"],
    risks:["盤整就是三筆權利金一起融化","事件後的 IV Crush 傷害加倍"],
    tip:"偏向要多少直接改口數；左側每一腳都能單獨調整數量。" },

  { key:"strip", cat:"做多波動率", name:"買進偏空跨式", en:"Strip",
    view:"預期大波動，偏向下跌", flow:"借記（高）", maxP:"標的歸零時最大", maxL:"三筆權利金全額",
    build:"買進 1 口價平買權 ＋ 買進 2 口價平賣權",
    legs:(s,atm) => [mkLeg("call", 1, atm, 1), mkLeg("put", 1, atm, 2)],
    goal:"跨式的偏空版：預期有大行情，而且比較可能往下——高估值股票的財報前常見。",
    pros:["下跌時獲利加倍","崩跌時 IV 上升與方向雙重助攻","猜錯方向仍有買權接手"],
    cons:["偏斜讓賣權更貴，買兩口成本很高","需要更大的跌幅才回本"],
    risks:["盤整時三筆權利金一起衰減","急跌後 IV 回落會吐回帳面獲利"],
    tip:"先用本頁看損益兩平要跌幾 %，再對照這檔標的過去的實際跌幅。" },

  { key:"call-backspread", cat:"做多波動率", name:"買權比例逆價差", en:"Call Ratio Backspread",
    view:"要嘛不動、要嘛噴出", flow:"通常小額貸記", maxP:"上檔無上限", maxL:"約 履約價差 − 淨權利金（停在買進腳最痛）",
    build:"賣出 1 口價平買權 ＋ 買進 2 口更高履約價買權",
    legs:(s,atm) => [mkLeg("call", -1, atm, 1), mkLeg("call", 1, atm + 2*s, 2)],
    goal:"用賣出的那口價平買權支付兩口價外買權：不漲不跌時小賺或打平，真的噴出時上檔無限。",
    pros:["建倉常常是倒收權利金","暴漲時獲利沒有上限","適合軋空、併購、題材發酵的情境"],
    cons:["最痛的是溫和上漲，剛好停在買進腳附近","中間區域的時間衰減對自己不利"],
    risks:["溫和上漲是最差劇本，虧損在買進腳達到最大","IV 下降不利","需要保證金"],
    tip:"這是把賭注押在尾部而不是中間；和比例價差（1×2）剛好是反過來的兩件事。" },

  { key:"put-backspread", cat:"做多波動率", name:"賣權比例逆價差", en:"Put Ratio Backspread",
    view:"要嘛不動、要嘛崩跌", flow:"通常小額貸記", maxP:"標的歸零時最大", maxL:"約 履約價差 − 淨權利金（停在買進腳最痛）",
    build:"賣出 1 口價平賣權 ＋ 買進 2 口更低履約價賣權",
    legs:(s,atm) => [mkLeg("put", -1, atm, 1), mkLeg("put", 1, atm - 2*s, 2)],
    goal:"最常見的崩盤保險做法：賣一口價平賣權來養兩口價外賣權，平時接近零成本，真的崩了獲利很兇。",
    pros:["幾乎零成本甚至收權利金就能長期持有下檔保護","崩盤時 IV 暴升，Vega 與方向雙重助攻","標的不動時損失很小"],
    cons:["溫和下跌是最差劇本","偏斜讓價外賣權偏貴，比例不一定划算"],
    risks:["停在買進腳附近時虧損最大","需要保證金，且波動放大時會膨脹","反覆轉倉的成本會累積"],
    tip:"建倉前先看損益兩平：偏斜太陡時，這個結構的性價比會輸給直接買賣權。" },

  { key:"short-straddle", cat:"做空波動率", name:"賣出跨式", en:"Short Straddle",
    view:"預期盤整、IV 偏高", flow:"貸記（高）", maxP:"收到的權利金", maxL:"上檔無上限",
    build:"同時賣出同履約價的價平買權與賣權",
    legs:(s,atm) => [mkLeg("call", -1, atm, 1), mkLeg("put", -1, atm, 1)],
    goal:"賣掉市場對波動的過度定價，賺時間價值與 IV 收斂——標的不動就是最好的劇本。",
    pros:["收到的權利金最肥，Theta 最強","只要標的釘住不動就持續獲利","IV 從高檔回落時獲利很快"],
    cons:["Gamma 為負，行情一動虧損就加速","保證金重，且會隨波動放大而膨脹"],
    risks:["上檔理論無限、下檔到歸零，尾部風險是全表最大","跳空、事件、崩盤時無法即時避險","被追繳與強制平倉；價內腳被提前指派"],
    warn:"高風險：這是典型「在推土機前撿硬幣」的部位，多數人應該改用賣出鐵蝶（兩側買保護腳）。",
    tip:"若真的要做，務必先想好停損與調整規則，並確認保證金能撐過 2–3 個標準差的走勢。" },

  { key:"short-strangle", cat:"做空波動率", name:"賣出勒式", en:"Short Strangle",
    view:"預期區間震盪", flow:"貸記", maxP:"收到的權利金", maxL:"上檔無上限",
    build:"賣出價外買權 ＋ 賣出價外賣權",
    legs:(s,atm) => [mkLeg("call", -1, atm + s, 1), mkLeg("put", -1, atm - s, 1)],
    goal:"比賣出跨式寬鬆的收租版本：留出一段容錯區間，只要標的待在區間裡就賺時間價值。",
    pros:["獲利區間比賣出跨式寬，勝率高","Theta 為正，IV 收斂時受惠"],
    cons:["收到的權利金比跨式少，卻同樣扛著無限風險","賺小賠大，單次意外可以抹掉數月獲利"],
    risks:["兩側都裸露，跳空無法閃避","保證金隨波動膨脹","提前指派"],
    warn:"高風險：兩側加上保護腳就是賣出鐵兀鷹，風險立刻變成一個固定數字。",
    tip:"履約價常取 Delta 0.15–0.20 附近；設定「收到權利金的一半就了結」之類的紀律。" },

  { key:"iron-condor", cat:"做空波動率", name:"賣出鐵兀鷹", en:"Iron Condor",
    view:"區間盤整", flow:"貸記", maxP:"收到的淨權利金", maxL:"單邊履約價差 − 淨權利金",
    build:"賣出勒式 ＋ 兩側各買一口更外側的保護腳",
    legs:(s,atm) => [mkLeg("put", 1, atm - 4*s, 1), mkLeg("put", -1, atm - 2*s, 1),
                     mkLeg("call", -1, atm + 2*s, 1), mkLeg("call", 1, atm + 4*s, 1)],
    goal:"最主流的中性收租策略：賺時間與 IV 收斂，同時把兩側尾部風險封在一個固定數字裡。",
    pros:["風險有限、保證金可控","Theta 為正，勝率高","建倉時報酬風險比就已知"],
    cons:["典型賠率約 1:3，賺小賠大，紀律不好就長期負期望","四腳的交易成本與滑價可觀"],
    risks:["趨勢盤是天敵，單邊走勢會直接吃到滿額虧損","IV 上升時帳面立刻難看","接近到期時 Gamma 風險陡增"],
    tip:"別讓部位撐到到期前幾天；多數做法是收到權利金的 40–60% 就先了結。" },

  { key:"iron-butterfly", cat:"做空波動率", name:"賣出鐵蝶", en:"Iron Butterfly",
    view:"標的釘在某個價位", flow:"貸記（比鐵兀鷹肥）", maxP:"收到的淨權利金", maxL:"翼展 − 淨權利金",
    build:"賣出價平買權與賣權 ＋ 兩側各買一口價外保護腳",
    legs:(s,atm) => [mkLeg("put", 1, atm - 2*s, 1), mkLeg("put", -1, atm, 1),
                     mkLeg("call", -1, atm, 1), mkLeg("call", 1, atm + 2*s, 1)],
    goal:"押標的到期時貼近某個價位：用價平雙賣收最多的時間價值，翼端買保護把風險封起來。",
    pros:["權利金收得比鐵兀鷹多，賠率較好","風險有限、保證金固定","IV 收斂時獲利明顯"],
    cons:["獲利區間窄，勝率明顯低於鐵兀鷹","價平腳的 Gamma 風險大，接近到期時損益跳動劇烈"],
    risks:["標的稍微偏離中心就轉虧","到期時價平腳的指派與 pin risk"],
    tip:"適合明確認為「就是會收在這附近」時使用；否則寬一點的鐵兀鷹比較好管理。" },

  { key:"call-butterfly", cat:"做空波動率", name:"買進蝶式（買權）", en:"Long Call Butterfly",
    view:"押到期落在中間履約價", flow:"借記（很低）", maxP:"翼展 − 淨權利金", maxL:"淨權利金",
    build:"買進低履約價買權 ＋ 賣出 2 口中間履約價買權 ＋ 買進高履約價買權",
    legs:(s,atm) => [mkLeg("call", 1, atm - 2*s, 1), mkLeg("call", -1, atm, 2), mkLeg("call", 1, atm + 2*s, 1)],
    goal:"用很小的成本狙擊一個目標價位：勝率低、賠率高的定點押注。",
    pros:["成本極低，最大虧損就是那一點借記","賠率可以到數倍","Vega 通常為負，IV 下降有利"],
    cons:["命中區間窄","離到期還久時損益幾乎不動，價值都在最後幾天才浮現"],
    risks:["1-2-1 共四筆交易，手續費與滑價比例很高","中間腳到期被指派的風險"],
    tip:"想偏多／偏空就把中心往上或往下移；這是「有明確目標價又想省錢」時的工具。" },

  { key:"bwb-put", cat:"做空波動率", name:"破翼蝶（賣權）", en:"Put Broken Wing Butterfly",
    view:"中性偏多", flow:"小額借記（實務上靠偏斜做成貸記）", maxP:"上翼寬 − 淨支出（標的落在賣出腳最好）", maxL:"下翼寬 − 上翼寬 ＋ 淨支出",
    build:"買進價外賣權 ＋ 賣出 2 口更價外賣權 ＋ 買進更遠的賣權（兩翼刻意不等寬）",
    legs:(s,atm) => [mkLeg("put", 1, atm - 2*s, 1), mkLeg("put", -1, atm - 4*s, 2), mkLeg("put", 1, atm - 7*s, 1)],
    goal:"把蝶式的一邊翅膀拉長，換取更好的建倉價格：上檔幾乎沒有風險（做成貸記時完全沒有），代價是下檔留一段有限的虧損。",
    pros:["上檔風險只剩那一點淨支出，標的大漲也幾乎不賠","最大虧損固定，比裸賣賣權安全得多","標的不動或緩跌時就能獲利"],
    cons:["下檔的虧損段比對稱蝶式寬","四腳的手續費與滑價","真正做成貸記需要偏斜配合"],
    risks:["快速下跌會掉進虧損最深的那一段","到期時中間兩口賣出腳的指派風險",
           "本頁範本讓所有腳位共用同一個 IV，因此算出來是小額借記；市場上要靠賣權偏斜（賣出腳的 IV 比買進腳高）才收得到權利金"],
    tip:"想看真實的貸記樣貌，把兩口賣出腳的 IV 往上調幾個百分點再看一次曲線——那個差額就是偏斜的價值。" },

  { key:"jade-lizard", cat:"做空波動率", name:"玉蜥蜴", en:"Jade Lizard",
    view:"中性偏多、IV 偏高", flow:"貸記", maxP:"收到的淨權利金", maxL:"賣權履約價 − 淨權利金（標的歸零）",
    build:"賣出價外賣權 ＋ 賣出價外買權 ＋ 買進更高履約價買權（＝賣權 ＋ 空頭買權價差）",
    legs:(s,atm) => [mkLeg("put", -1, atm - s, 1), mkLeg("call", -1, atm + 2*s, 1), mkLeg("call", 1, atm + 3*s, 1)],
    goal:"只要收到的權利金大於買權價差的寬度，上檔就完全沒有風險——一個「只怕跌」的收租結構。",
    pros:["上檔無風險（前提是權利金 > 買權價差寬度）","權利金比單賣賣權多一截","Theta 為正，IV 收斂時受惠"],
    cons:["下檔風險與裸賣賣權相同","三腳部位，調整與轉倉比較麻煩"],
    risks:["權利金收得不夠時，上檔仍會虧——建倉前務必確認","急跌時虧損可觀","價內腳的提前指派"],
    tip:"檢查方法很簡單：看本頁到期曲線的右半邊是不是一條在零以上的水平線。" },

  { key:"put-ratio", cat:"做空波動率", name:"賣權比例價差", en:"Put Ratio Spread（1×2）",
    view:"溫和看空，但認為跌不深", flow:"接近零成本或小額貸記", maxP:"約在賣出腳履約價達到最大", maxL:"標的續跌（有限但很大）",
    build:"買進 1 口價平賣權 ＋ 賣出 2 口更低履約價賣權",
    legs:(s,atm) => [mkLeg("put", 1, atm, 1), mkLeg("put", -1, atm - 2*s, 2)],
    goal:"押「會跌，但跌到某個價位就打住」，多賣的那口把建倉成本壓到接近零。",
    pros:["幾乎不花錢就建立空頭部位","標的到期正好停在賣出腳時報酬最好","時間衰減對自己有利"],
    cons:["跌過頭反而由賺轉賠","Gamma 為負，急跌時虧損加速"],
    risks:["多賣的那口是裸賣賣權，含指派與保證金風險","崩盤時虧損很大，且下跌波動偏斜會讓平倉成本更高"],
    warn:"高風險：下檔有 1 口沒有掩護的賣權；在下方再買一口更價外的賣權即可封住（就變成破翼蝶）。",
    tip:"賣出腳擺在你認為的支撐價位，並事先想好跌破時怎麼處理。" },

  { key:"synthetic-long", cat:"合成與進階", name:"合成多頭", en:"Synthetic Long Stock",
    view:"看多", flow:"接近零成本（視利率股息）", maxP:"無上限", maxL:"幾乎等同持股（可至歸零）",
    build:"買進價平買權 ＋ 賣出同履約價賣權",
    legs:(s,atm) => [mkLeg("call", 1, atm, 1), mkLeg("put", -1, atm, 1)],
    goal:"用選擇權複製現股的損益曲線，佔用的資金遠低於直接買股。",
    pros:["Delta ≈ 1，貼著現股走","兩腳的時間價值互相抵銷，幾乎沒有 Theta 損耗","資金效率高"],
    cons:["下檔風險與持股相同，卻是用保證金撐著，等於加了槓桿","沒有股息與股東權利","要處理到期轉倉"],
    risks:["保證金追繳；賣權腳被指派","把買賣方向對調就是合成空頭，風險同理但上檔無限"],
    tip:"這正是期貨與選擇權之間的平價關係；用它可以檢查自己的組合有沒有隱含的現股部位。" },

  { key:"risk-reversal", cat:"合成與進階", name:"風險逆轉", en:"Risk Reversal",
    view:"看多，且認為賣權太貴", flow:"接近零成本或小額貸記", maxP:"無上限", maxL:"賣權履約價以下的全部跌幅",
    build:"賣出價外賣權 ＋ 買進價外買權",
    legs:(s,atm) => [mkLeg("put", -1, atm - 2*s, 1), mkLeg("call", 1, atm + 2*s, 1)],
    goal:"利用「賣權比買權貴」的偏斜，用賣出下檔保險來支付上檔樂透；法人也常用它替既有空頭曝險做對沖。",
    pros:["幾乎零成本就取得上檔曝險","偏斜越陡越划算","可調整兩腳履約價來控制成本與風險"],
    cons:["中間區間完全沒有損益，行情不動就白等","下檔風險實質等同持股"],
    risks:["崩盤時被指派，且帳戶其實有槓桿","保證金需求會隨波動上升"],
    tip:"把它想成「用願意接股票的承諾，去換上檔選擇權」；不願接股票就別做。" },

  { key:"call-ratio", cat:"合成與進階", name:"買權比例價差", en:"Call Ratio Spread（1×2）",
    view:"溫和看多，但認為漲不多", flow:"接近零成本或小額貸記", maxP:"約在賣出腳履約價達到最大", maxL:"上檔無上限",
    build:"買進 1 口價平買權 ＋ 賣出 2 口更高履約價買權",
    legs:(s,atm) => [mkLeg("call", 1, atm, 1), mkLeg("call", -1, atm + 2*s, 2)],
    goal:"押「會漲，但漲不過某個價位」：多賣的那一口把建倉成本壓到接近零，甚至倒收權利金。",
    pros:["幾乎不花錢就建立多頭部位","標的到期正好停在賣出腳時報酬最好","時間衰減對自己有利"],
    cons:["漲過頭反而由賺轉賠，而且上檔無上限","Gamma 為負，強勢突破時虧損加速"],
    risks:["多賣的那一口等於裸賣買權，含所有裸賣風險","保證金與跳空風險"],
    warn:"高風險：上檔有 1 口沒有掩護的買權；在上方再買一口更價外的買權即可封住（變成聖誕樹／反向比例價差）。",
    tip:"賣出腳擺在自己認定的壓力價位，並且事先想好突破時怎麼處理。" },

  { key:"synthetic-short", cat:"合成與進階", name:"合成空頭", en:"Synthetic Short Stock",
    view:"看空", flow:"接近零成本（視利率股息）", maxP:"履約價 ± 淨權利金（標的歸零）", maxL:"無上限",
    build:"賣出價平買權 ＋ 買進同履約價賣權",
    legs:(s,atm) => [mkLeg("call", -1, atm, 1), mkLeg("put", 1, atm, 1)],
    goal:"不必借券就複製放空的損益曲線，資金效率高；也常用來把手上的多頭部位就地鎖住。",
    pros:["免借券、沒有借券費與被回補的問題","Delta ≈ −1，貼著現股反向走","兩腳時間價值互相抵銷，幾乎沒有 Theta 損耗"],
    cons:["上檔風險無限，與放空現股相同","佔用保證金，且會隨標的上漲膨脹","要處理到期轉倉"],
    risks:["軋空","賣出的買權在除息前可能被提前指派","被追繳與強制平倉"],
    warn:"高風險：上檔沒有任何保護，尾部風險等同裸賣買權。",
    tip:"想留一點保護，就把賣出的買權換成買權價差；那就變成海鷗的空頭版本。" },

  { key:"seagull", cat:"合成與進階", name:"海鷗", en:"Seagull",
    view:"看多，要求零成本", flow:"接近零成本", maxP:"上方買權價差的寬度", maxL:"賣權履約價以下的全部跌幅",
    build:"賣出價外賣權 ＋ 買進價外買權 ＋ 賣出更高履約價買權",
    legs:(s,atm) => [mkLeg("put", -1, atm - 2*s, 1), mkLeg("call", 1, atm + 2*s, 1), mkLeg("call", -1, atm + 6*s, 1)],
    goal:"風險逆轉的省錢版：再賣掉一口更高的買權替上檔加個天花板，換取更好的建倉價格甚至倒收權利金。",
    pros:["通常能做到零成本","三腳同一到期日，比跨期結構好管理","企業避險與外匯市場的標準工具"],
    cons:["上檔被天花板封住","下檔風險實質等同持股","中間區間完全沒有損益"],
    risks:["崩盤時賣權腳被指派","保證金需求","三腳的買賣價差"],
    tip:"三個履約價就是「成本、上檔、下檔」的三向取捨；用本頁曲線調到你能接受的形狀再下單。" },

  { key:"box", cat:"套利與定價", name:"盒式價差", en:"Box Spread",
    view:"與方向無關（資金工具）", flow:"借記或貸記（等於存錢或借錢）", maxP:"兩履約價差（到期時固定）", maxL:"建倉價與價差之間的落差",
    build:"低履約價的合成多頭 ＋ 高履約價的合成空頭（四腳同到期）",
    legs:(s,atm) => [mkLeg("call", 1, atm - 2*s, 1), mkLeg("put", -1, atm - 2*s, 1),
                     mkLeg("call", -1, atm + 2*s, 1), mkLeg("put", 1, atm + 2*s, 1)],
    goal:"到期損益固定等於兩個履約價的差，等於透過選擇權市場借錢或存錢；法人用它做資金調度，也用來檢查市場的隱含利率。",
    pros:["到期價值與標的走勢完全無關","可以反推市場真正的資金成本","資金成本有時優於券商融資利率"],
    cons:["報酬極薄，只有幾個百分點的年化","四腳的手續費與買賣價差常常就把利潤吃光"],
    risks:["美式選擇權可能被提前指派，「無風險」瞬間變成單邊部位","到期前保證金仍會隨市場波動","流動性差時根本成交不了"],
    warn:"與直覺相反的高風險：只有歐式、現金結算的標的才接近無風險；用美式個股選擇權做盒式價差而爆倉的案例並不少見。",
    tip:"用本頁把到期曲線畫出來檢查：應該是一條水平線，任何傾斜都代表腳位擺錯了。" },

  { key:"conversion", cat:"套利與定價", name:"轉換套利", en:"Conversion",
    view:"與方向無關（定價套利）", flow:"借記（等於買進現股）", maxP:"鎖定後的微小價差", maxL:"鎖定後的微小價差",
    build:"買進現股 ＋ 買進價平賣權 ＋ 賣出同履約價買權",
    legs:(s,atm,m) => [mkLeg("stock", 1, 0, m), mkLeg("put", 1, atm, 1), mkLeg("call", -1, atm, 1)],
    goal:"用買賣權平價關係把現股鎖成一張合成債券：到期不管漲跌都以履約價出場，賺的是定價偏差與利息。",
    pros:["幾乎沒有市場風險","是理解買賣權平價（現股 ＝ 買權 − 賣權 ＋ 履約價現值）最直觀的方式","可用來檢查自己的組合裡有沒有藏著現股部位"],
    cons:["報酬極薄，散戶的手續費通常就吃光了","佔用大量資金"],
    risks:["買權在除息前被提前指派會打破鎖定","股息政策與利率變動","資金與借券成本"],
    tip:"把它和領口比一比：同履約價的領口就是轉換，把履約價拉開才變成有區間的保護。" }
];
export const STRAT = Object.fromEntries(STRATEGIES.map(x => [x.key, x]));

/* 選單由資料生成，加一個策略只要往 STRATEGIES 加一筆 */
export const PRESET_GROUPS = [...new Set(STRATEGIES.map(x => x.cat))].map(cat => ({
  cat,
  items: STRATEGIES.filter(x => x.cat === cat).map(st => ({
    key: st.key,
    label: st.name + "　" + st.en.replace(/（.*）/, "")
  }))
}));

// 目前堆疊中還認得的範本（過濾掉壞掉的連結）
export const stackList = () => state.presets.map(p => ({...p, st:STRAT[p?.k]})).filter(x => x.st);

/* 疊加之後，畫面上的腳位是好幾個範本加起來的，範本自己那句「最大獲利＝履約價差 − 淨權利金」
   已經不成立了。所以組合部位的五個數字一律改用 analyze() 的實算值，
   範本的文字敘述退居下方，只說明「這個組件本身在做什麼」。 */
/* 建倉現金流的實算敘述。單一範本與疊加檢視共用同一個字串——
   範本自己的 flow 欄位（「貸記（持股成本另計）」之類）只描述型態、沒有數字，
   單獨看反而是最常用的情境卻讀不到金額。 */
export function cashFlowText(a){
  const flow = Math.abs(a.netPremium) < 0.005 ? "收支相抵"
    : a.netPremium > 0 ? `貸記 ${money(a.netPremium)}` : `借記 ${money(-a.netPremium)}`;
  return flow + (Math.abs(a.stockCost) > 0.005 ? `（另含現股 ${money(a.stockCost)}）` : "");
}

export function comboFacts(a){
  return [
    ["淨部位", netLegSummary()],
    ["現金流", cashFlowText(a)],
    ["最大獲利", isFinite(a.maxProfit) ? money(a.maxProfit) : "無上限"],
    ["最大虧損", isFinite(a.maxLoss) ? money(a.maxLoss) : "無下限"],
    ["損益兩平", a.breakevens.length ? a.breakevens.map(price).join("　") : "全區間同方向"]
  ];
}

/* 疊加不會自動合併腳位（合併掉就分不出哪一腳來自哪個範本、也就拆不掉了），
   所以另外算一份「淨部位」：同型別同履約價的口數相加減，這才是實際承擔的曝險。 */
export function netLegParts(){
  const m = new Map();
  for(const l of state.legs){
    // 到期日要進 key：同履約價但不同月份的兩口買權是兩個不同的合約，
    // 抵銷掉就會把日曆／對角價差算成淨部位為零
    const key = l.type + "|" + l.K + "|" + legDte(l);
    m.set(key, (m.get(key) || 0) + l.side*l.qty);
  }
  const order = {stock:0, call:1, put:2};
  return [...m.entries()]
    .map(([key, n]) => { const [type, K, d] = key.split("|"); return {type, K:+K, d:+d, n}; })
    .filter(x => Math.abs(x.n) > 1e-9)
    .sort((a, b) => order[a.type] - order[b.type] || a.K - b.K || a.d - b.d)
    .map(x => x.type === "stock"
      ? `${x.n > 0 ? "＋" : "−"}${nf(Math.abs(x.n), 0)} 股現股`
      : `${x.n > 0 ? "＋" : "−"}${Math.abs(x.n)} 口 ${x.type === "call" ? "買權" : "賣權"} ${price(x.K)}`
        + (x.d > state.dte ? `（${x.d} 天）` : ""));
}
export const netLegSummary = () => netLegParts().join("　") || "所有腳位互相抵銷，淨部位為零";

// 同型別、同履約價、同到期日、同權利金、同 IV 的腳位才可合併——權利金不同代表是
// 不同時點建的，併成一口就會把兩筆成本混在一起；到期日不同則根本是兩個合約。
const legKey = l => `${l.type}|${l.K}|${legDte(l)}|${l.premium}|${l.iv ?? state.iv}`;
export function mergeableCount(){
  const m = new Map();
  for(const l of state.legs) m.set(legKey(l), (m.get(legKey(l)) || 0) + 1);
  return [...m.values()].filter(n => n > 1).length;
}

/* stack=false 取代整個部位（原本的行為）；stack=true 保留現有腳位再疊上去。
   疊加時履約價級距用「現在的」state 算，所以兩個範本落在同一組履約價上，
   同一腳會出現兩次而不會自動合併——這樣才知道每一腳是誰帶進來的。 */
export function applyPreset(key, stack){
  const st = STRAT[key]; if(!st) return;
  const g = nextGroupId();
  const legs = st.legs(presetStep(), roundStrike(state.S), state.mult).map(l => ({...l, g}));
  if(stack){
    state.presets = [...state.presets, {k:key, g}];
    state.legs = [...state.legs, ...legs];
  }else{
    state.presets = [{k:key, g}];
    state.legs = legs;
  }
}

// 拆掉堆疊裡的一個範本：連同它帶進來、之後也沒被手動改動過的腳位一起移除
export function dropPresetGroup(g){
  state.presets = state.presets.filter(p => p?.g !== g);
  state.legs = state.legs.filter(l => l.g !== g);
}

/* 合併重複腳位：疊加常會疊出兩口一模一樣的合約，併成一口比較好讀。
   併完之後腳位不再屬於任何一個範本，所以連結一起解除——留著會讓「移除範本」
   把別人的口數也一起帶走。損益完全不變，只是列表變短。 */
export function mergeDuplicateLegs(){
  const seen = new Map();
  for(const l of state.legs){
    const k = legKey(l), hit = seen.get(k);
    if(hit) hit.net += l.side*l.qty;
    else seen.set(k, {leg:l, net:l.side*l.qty});
  }
  state.legs = [...seen.values()]
    .filter(x => Math.abs(x.net) > 1e-9)
    .map(x => ({...x.leg, side:x.net > 0 ? 1 : -1, qty:Math.abs(x.net), g:undefined}));
  clearPreset();
}

// 手動改動腳位之後，說明就不再對應畫面上的部位了
export function clearPreset(){
  if(!state.presets.length) return;
  state.presets = [];
  for(const l of state.legs) delete l.g;
}

// 只動到一腳（改型別、翻買賣、刪除）時，只解除那一腳所屬的那個範本，
// 其餘疊加上去的範本仍然成立，不必整組作廢。
export function unlinkLeg(leg){
  const g = leg?.g;
  if(g == null) return;
  for(const l of state.legs) if(l.g === g) delete l.g;
  state.presets = state.presets.filter(p => p?.g !== g);
}
