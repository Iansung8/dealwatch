// 店家清單：代號、顯示名稱、表格縮寫、config.categories[*].queries 裡用的鍵名。
// 新增店家時在這裡加一筆，再到 src/monitor.mjs 的 storeJobs / storeProduct 接上搜尋與單品查詢。
export const STORES = {
  bb: { name: 'Best Buy', short: 'BB', queries: 'bestbuy' },
  wm: { name: 'Walmart', short: 'WM', queries: 'walmart' },
  wt: { name: 'Woot', short: 'WT', queries: 'woot' },
  tm: { name: 'Temu', short: 'TM', queries: 'temu' },
};

export const storeName = code => STORES[code]?.name ?? code;
export const storeShort = code => STORES[code]?.short ?? String(code).toUpperCase();
