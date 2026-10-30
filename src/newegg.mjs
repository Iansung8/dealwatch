// Newegg：搜尋頁 HTML 內嵌的 window.__initialState__（Products 陣列）。
// 介面（src/monitor.mjs 會呼叫）：
//   search({ query, minPrice, maxPrice }, httpOptions) -> { total, items }
//   product(itemNumber) -> items   指定商品用，itemNumber 是商品網址 /p/<itemNumber> 那一段
// TODO(worker): 實作
export async function search() { throw new Error('Newegg 尚未實作'); }
export async function product() { throw new Error('Newegg 尚未實作'); }
