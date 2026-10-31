// Micro Center：搜尋頁。直接請求一律 403，只能用瀏覽器載入；價格與庫存以 config.microcenter.storeId 那家門市為準。
// 介面（src/monitor.mjs 會呼叫）：
//   configure({ browser, storeId, gapMs })
//   search({ query, minPrice, maxPrice }) -> { total, items }
//   product(productId) -> items   指定商品用，productId 是商品網址 /product/<productId>/ 那一段
// TODO: 待實作（stub）
let browser = null;

export function configure({ browser: b = null } = {}) { browser = b; }

export async function search() {
  if (!browser) throw new Error('Micro Center 需要瀏覽器');
  return { total: 0, items: [] };
}

export async function product() { return []; }
