// Temu：沒有可直接呼叫的公開端點，搜尋要登入。用 dealwatch 專用的瀏覽器（使用者自己登入過的）載入搜尋頁，
// 從畫面上的商品卡讀資料。遇到登入頁或人機驗證就丟 Blocked，等使用者在那個視窗親手處理。
// 介面（src/monitor.mjs 會呼叫）：
//   configure({ browser })        傳入 src/browser.mjs 的 Browser（跟 Walmart 共用同一個分頁，載入會排隊）
//   search({ query, minPrice, maxPrice }) -> { total, items }
//   product(goodsId) -> items     指定商品用
// items 的格式跟 src/bestbuy.mjs / src/walmart.mjs 的 normalize 一樣（store: 'tm'）。
// TODO(worker): 實作
let browser = null;
export function configure({ browser: b = null } = {}) { browser = b; }
export async function search() { throw new Error('Temu 尚未實作'); }
export async function product() { throw new Error('Temu 尚未實作'); }
