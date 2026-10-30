// Newegg：搜尋頁 HTML 內嵌的 window.__initialState__（Products 陣列）。
// 商品頁同樣有 __initialState__，鍵是 ItemDetail（實際擺法未經瀏覽器驗證，解析時容錯幾種常見結構）。
// 介面（src/monitor.mjs 會呼叫）：
//   search({ query, minPrice, maxPrice }, httpOptions) -> { total, items }
//   product(itemNumber) -> items   指定商品用，itemNumber 是商品網址 /p/<itemNumber> 那一段
import { get, Blocked, RequestError, requireSuccess } from './http.mjs';

const BASE = 'https://www.newegg.com';

const money = v => {
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

// 搜尋頁；排序參數未經真實頁面驗證，先用 Newegg 的預設排序。
export function searchUrl(query) {
  const u = new URL(`${BASE}/p/pl`);
  u.searchParams.set('d', String(query ?? ''));
  return u.href;
}

export const productUrl = id => `${BASE}/p/${encodeURIComponent(String(id ?? '').trim())}`;

// 加入購物車只對 Newegg 自營有效；第三方商品要帶 SellerId，這裡不猜，改開商品頁。
// 搜尋結果的編號是 20-982-099 這種短格式，加入購物車要用完整的 N82E16820982099（已在瀏覽器實測可加入）。
// 其他格式（例如 1FT-000M-00474）沒驗證過，不給連結，改開商品頁。
export function cartItemNumber(id) {
  const s = String(id ?? '').trim().toUpperCase();
  if (/^N82E\d+$/.test(s)) return s;
  if (/^\d{2}-\d{3}-\d{3}$/.test(s)) return `N82E168${s.replace(/-/g, '')}`;
  return null;
}
const cartUrl = (id, seller) => {
  const item = seller === 'Newegg' && cartItemNumber(id);
  return item ? `https://secure.newegg.com/Shopping/AddtoCart.aspx?Submit=ADD&ItemList=${item}` : null;
};

// 從 HTML 取出 window.__initialState__。頁面裡另一段 JS 也會提到這個名字但不是賦值，所以要求 "="。
export function initialState(html) {
  const m = /window\.__initialState__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/.exec(html);
  if (!m) {
    if (/are you a human|captcha|just a moment|challenge-platform|enable javascript and cookies/i.test(html)) {
      throw new Blocked('Newegg 要求人機驗證');
    }
    throw new RequestError('Newegg 頁面格式不符（找不到 __initialState__）', 'format');
  }
  try {
    const data = JSON.parse(m[1]);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new RequestError('Newegg __initialState__ 格式不符', 'format');
  }
}

// 自營可能寫 Newegg、Newegg.com；null 也視為自營
const sellerName = raw => {
  const s = String(raw ?? '').trim();
  return !s || /^newegg(?:\.com| inc\.?)?$/i.test(s) ? 'Newegg' : s;
};

// 分類用的 type：Newegg 的 Subcategory 描述本身就含 Video Card / Laptops / Processors / Memory 等字。
const typeOf = sub => [sub?.SubcategoryDescription, sub?.RealSubCategoryDescription].filter(Boolean).join(' ');

function makeItem(o) {
  const id = String(o.id ?? '').trim();
  if (!id) return null;
  const price = money(o.price);
  // 劃線原價：OriginalUnitPrice 優先；沒有時 UnitCost 大於售價也可視為原價（否則忽略）
  const ref = [o.original, o.unitCost].map(money).find(v => v != null && price != null && v > price);
  const seller = sellerName(o.seller);
  const feature = o.feature ?? {};
  const kind = feature.IsOpenBoxed || o.openBox ? 'ob'
    : feature.IsRefurbished || o.refurb ? 'refurb' : 'new';
  const slug = String(o.slug ?? '').replace(/^\/+|\/+$/g, '');
  return {
    store: 'ne',
    id,
    key: `ne:${id}`,
    kind,
    cond: { ob: 'Open-Box', refurb: 'Refurb', new: 'New' }[kind],
    name: o.title ?? '',
    type: o.type || o.title || '',
    seller,
    price,
    ref,
    // 缺欄位時視為有貨，不要因為贊助／組合包少欄位就丟掉
    inStock: o.instock !== false && o.instock !== 0 && o.active !== false && o.active !== 0,
    url: slug ? `${BASE}/${slug}/p/${id}` : productUrl(id),
    cartUrl: cartUrl(id, seller),
  };
}

function normalizeCell(product) {
  const cell = product?.ItemCell;
  if (!cell?.Item) return null;
  const desc = cell.Description ?? {};
  return makeItem({
    id: cell.Item,
    title: desc.Title,
    slug: desc.UrlKeywords,
    type: typeOf(cell.Subcategory),
    price: cell.FinalPrice ?? cell.UnitCost,
    unitCost: cell.UnitCost,
    original: cell.OriginalUnitPrice,
    instock: cell.Instock,
    active: cell.Active,
    feature: cell.Feature,
    seller: cell.Seller?.SellerName,
  });
}

// 直接請求常被 Cloudflare 擋（403 + cf-mitigated: challenge）。有給瀏覽器的話就改用 dealwatch 專用 Chrome 載入，
// 跟 Walmart 共用同一個分頁排隊。被擋過記 6 小時，這段時間直接走瀏覽器不再白試。
let browser = null;
let httpBlockedUntil = 0;
const HTTP_BLOCK_MS = 6 * 36e5;

export function configure({ browser: b = null } = {}) { browser = b; httpBlockedUntil = 0; }
export const usingBrowser = () => !!browser && Date.now() < httpBlockedUntil;

// 取得頁面並解析 __initialState__
async function pageState(url, httpOptions) {
  if (!usingBrowser()) {
    try {
      const response = await get('ne', url, httpOptions);
      requireSuccess('Newegg', response);
      return initialState(response.body);
    } catch (err) {
      if (!(err instanceof Blocked) || !browser) throw err;
      httpBlockedUntil = Date.now() + HTTP_BLOCK_MS;
    }
  }
  try {
    const state = initialState(await browser.html(url));
    browser.hold = false;
    return state;
  } catch (err) {
    if (!(err instanceof Blocked)) throw err;
    // 瀏覽器裡也跳驗證：留著頁面、帶到最前面等你親手處理
    browser.keepOpen = browser.hold = true;
    await browser.focus();
    throw new Blocked('Newegg 在瀏覽器裡要求人機驗證，請在 dealwatch 專用瀏覽器視窗手動完成');
  }
}

export async function search({ query, minPrice, maxPrice } = {}, httpOptions) {
  const data = await pageState(searchUrl(query), httpOptions);
  const products = Array.isArray(data.Products) ? data.Products : [];
  const items = products.map(normalizeCell).filter(Boolean);
  const total = Number.parseInt(data.TotalItemCount, 10);
  return {
    total: Number.isFinite(total) ? total : items.length,
    // 價格條件在本地過濾
    items: items.filter(i => (minPrice == null || i.price >= minPrice) && (maxPrice == null || i.price <= maxPrice)),
  };
}

// 商品頁的 ItemDetail 可能直接放商品欄位，也可能包在 ItemInfo / Item / Product 底下
const idOf = d => d.ItemNumber ?? d.ItemId ?? (typeof d.Item === 'string' ? d.Item : undefined);

function detailOf(data) {
  const roots = [data?.ItemDetail, data?.ItemInfo, data?.Product, data?.Item];
  for (const root of roots) {
    if (!root || typeof root !== 'object' || Array.isArray(root)) continue;
    for (const d of [root, root.ItemInfo, root.Item, root.Product]) {
      if (d && typeof d === 'object' && (idOf(d) || d.Title)) return d;
    }
  }
  return null;
}

function normalizeDetail(d, fallbackId) {
  const desc = d.Description ?? {};
  const feature = { ...(d.Feature ?? {}) };
  // 商品頁可能只有文字條件，沒有布林旗標
  const condition = String(d.Condition ?? d.ItemCondition ?? '');
  if (/open[\s-]*box/i.test(condition)) feature.IsOpenBoxed = true;
  if (/refurb|recondition|renewed/i.test(condition)) feature.IsRefurbished = true;
  const availability = d.Availability;
  return makeItem({
    id: idOf(d) ?? fallbackId,
    title: d.Title ?? desc.Title ?? d.ProductName,
    slug: d.UrlKeywords ?? desc.UrlKeywords,
    type: typeOf(d.Subcategory) || typeOf(d.ItemDetails?.Subcategory),
    price: d.FinalPrice ?? d.UnitCost ?? d.CurrentPrice ?? d.Price,
    unitCost: d.UnitCost,
    original: d.OriginalUnitPrice,
    instock: d.Instock ?? d.InStock ?? (typeof availability === 'string' ? !/out\s*of\s*stock|unavailable/i.test(availability) : undefined),
    active: d.Active,
    feature,
    seller: d.Seller?.SellerName ?? d.SellerName,
  });
}

export async function product(itemNumber) {
  const id = String(itemNumber ?? '').trim();
  if (!id) return [];
  const detail = detailOf(await pageState(productUrl(id)));
  const item = detail && normalizeDetail(detail, id);
  return item ? [item] : [];
}
