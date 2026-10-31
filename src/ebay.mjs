// eBay：直購（Buy It Now）搜尋結果。直接請求一律 403，只能用瀏覽器載入。
// 介面（src/monitor.mjs 會呼叫）：
//   configure({ browser, conditions, usOnly, gapMs, ... })
//   search({ query, minPrice, maxPrice, category }) -> { total, items }
//   product(itemId) -> items      指定商品用，itemId 是商品網址 /itm/<itemId> 那一段
// TODO: 待實作（stub）
let browser = null;

export function configure({ browser: b = null } = {}) { browser = b; }

export async function search() {
  if (!browser) throw new Error('eBay 需要瀏覽器');
  return { total: 0, items: [] };
}

export async function product() { return []; }
