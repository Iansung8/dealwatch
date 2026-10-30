// Woot（Amazon 旗下的限時特賣）：走官網前端用的 AppSync GraphQL（GET + 公開的 x-api-key）。
// 介面（src/monitor.mjs 會呼叫）：
//   search({ query, minPrice, maxPrice, limit }, httpOptions) -> { total, items }
//   product(slug) -> items        指定商品用，slug 是商品網址 /offers/<slug> 那一段
//   offerUrl(siteName, slug) -> 商品頁網址
// items 的格式跟 src/bestbuy.mjs / src/walmart.mjs 的 normalize 一樣（store: 'wt'）。
// TODO(worker): 實作
export async function search() { throw new Error('Woot 尚未實作'); }
export async function product() { throw new Error('Woot 尚未實作'); }
export function offerUrl(siteName, slug) { return `https://www.woot.com/offers/${slug}`; }
