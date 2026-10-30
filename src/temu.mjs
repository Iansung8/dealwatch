// Temu：沒有可直接呼叫的公開端點，搜尋要登入。用 dealwatch 專用的瀏覽器（使用者自己登入過的）載入搜尋頁，
// 從畫面上的商品卡讀資料。遇到登入頁或人機驗證就丟 Blocked，等使用者在那個視窗親手處理。
// 介面（src/monitor.mjs 會呼叫）：
//   configure({ browser })        傳入 src/browser.mjs 的 Browser（跟 Walmart 共用同一個分頁，載入會排隊）
//   search({ query, minPrice, maxPrice }) -> { total, items }
//   product(goodsId) -> items     指定商品用
// items 的格式跟 src/bestbuy.mjs / src/walmart.mjs 的 normalize 一樣（store: 'tm'）。
//
// 探索觀察（2026-10，Chrome 156，未登入，介面語言 zh-Hant）：
// - search_result.html 會被導到 bgn_verification.html（「安全驗證」，圖形點選）或 login.html。
// - 商品頁 <slug>-g-<id>.html 未登入一律導到 login.html；goods.html?goods_id=<id> 也一樣。
// - 分類 / SEO 落地頁（/gpu-s.html → bmw.html?seo_search=1&search_key=gpu）未登入仍會渲染商品卡，
//   資料在 window.rawData.stores.store.componentSsrDataMap.<hash>.goodsList[*].data：
//     { goodsId, title, priceInfo: { price(美分), priceStr, marketPrice(美分), marketPriceStr, orgPrice }, seoLinkUrl, status }
// - DOM 卡片：a[href*="-g-<id>.html"] 內有 [data-id="goods-card-container"][data-unique-id=<id>][data-tooltip-title=<標題>]、
//   [data-type="price"]（$ 與數字常分成多個 span）、[data-type="marketPrice"]（劃線原價）、[data-type="discount"]。
//   售完卡片有「售罄」字樣；「即將售罄」只是低庫存，不算售完。i18n 裡 soldOut = 售罄。
// - 未登入看不到搜尋頁，所以搜尋頁的 rawData 是依分類頁的結構推測（同樣是 componentSsrDataMap 裡的 goodsList），
//   解析時會遞迴找第一個 goodsList，找不到才退回 DOM。
import { Blocked, RequestError } from './http.mjs';

const BASE = 'https://www.temu.com';
const LOGIN_HINT = 'Temu 需要登入：請在 dealwatch 專用瀏覽器視窗登入 Temu 帳號（node dealwatch.mjs browser）';
const VERIFY_HINT = 'Temu 要求人機驗證，請在瀏覽器視窗手動完成';
const NEED_BROWSER = 'Temu 需要瀏覽器（dealwatch 專用 Chrome）';

let browser = null;
export function configure({ browser: b = null } = {}) { browser = b; }

export function searchUrl(query) {
  const u = new URL(`${BASE}/search_result.html`);
  u.searchParams.set('search_key', query ?? '');
  return u.href;
}

// 有 slug 的商品頁網址；拿不到 slug 時退回 goods.html（Temu 會自己導到正式網址）
export const productUrl = id => `${BASE}/goods.html?goods_id=${encodeURIComponent(id)}`;

// $1,234.56、US$1,234、原價$25.96、或分段 span 串起來的「$12.34$12.34」都取第一個價格
export function parsePrice(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined;
  const text = String(value ?? '');
  const m = text.match(/(?:US)?\$\s*([\d,]+(?:\.\d{1,2})?)/i) ?? text.match(/([\d,]+(?:\.\d{1,2})?)/);
  if (!m) return undefined;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// 「即將售罄」是低庫存，不算售完；先移除再比對
const SOLD_OUT_RE = /sold\s*out|out\s*of\s*stock|已售完|售完|售罄/i;
export const isSoldOutText = text => SOLD_OUT_RE.test(String(text ?? '').replace(/即將\s*(?:售罄|售完)/g, ''));

const cents = v => {
  if (v == null || v === '') return undefined;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) / 100 : undefined;
};

// 從 seoLinkUrl（/us-zh-Hant/<slug>-g-<id>.html）或完整網址取出不含語系前綴的商品頁網址
function cardUrl(id, raw) {
  const m = String(raw ?? '').match(/([^/?#]+-g-(\d+)\.html)(?:[?#]|$)/);
  if (m && m[2] === id) return `${BASE}/${m[1]}`;
  return productUrl(id);
}

const moneyOf = (str, centsValue, fallback) =>
  parsePrice(str) ?? (centsValue != null ? cents(centsValue) : undefined) ?? parsePrice(fallback);

// 把頁面抽出的卡片陣列正規化成 monitor 用的商品格式。解析不出價格或 goodsId 的卡片直接丟掉。
export function parseCards(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set(), items = [];
  for (const card of list) {
    const id = String(card?.goodsId ?? card?.id ?? '').trim();
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    const price = moneyOf(card.priceStr, card.priceCents, card.price);
    if (!(price > 0)) continue;
    const market = moneyOf(card.marketPriceStr, card.marketPriceCents, card.marketPrice ?? card.ref);
    const soldOut = card.soldOut === true || card.inStock === false;
    seen.add(id);
    items.push({
      store: 'tm',
      id,
      key: `tm:${id}`,
      kind: 'new',
      cond: 'New',
      name: String(card.title ?? card.name ?? ''),
      type: '',
      seller: String(card.seller ?? card.storeName ?? '').trim() || 'Temu',
      price,
      ref: market > price ? market : undefined,
      inStock: !soldOut,
      url: cardUrl(id, card.url ?? card.seoLinkUrl ?? card.href),
      cartUrl: null,
    });
  }
  return items;
}

// 在 rawData 裡遞迴找第一個 goodsList（搜尋頁 / 分類頁都掛在 componentSsrDataMap 底下）
function findGoodsList(node, depth, seen) {
  if (!node || typeof node !== 'object' || depth > 8 || seen.has(node)) return null;
  seen.add(node);
  if (!Array.isArray(node)) {
    if (Array.isArray(node.goodsList) && node.goodsList.some(i => ((i?.data ?? i)?.goodsId) != null)) return node.goodsList;
  }
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    const hit = findGoodsList(value, depth + 1, seen);
    if (hit) return hit;
  }
  return null;
}

const cardFromGoods = d => ({
  goodsId: d.goodsId,
  title: d.title ?? d.goodsName ?? '',
  priceStr: d.priceInfo?.priceStr ?? d.priceInfo?.showPriceStrValue ?? '',
  priceCents: d.priceInfo?.price,
  marketPriceStr: d.priceInfo?.marketPriceStr ?? '',
  marketPriceCents: d.priceInfo?.marketPrice,
  url: d.seoLinkUrl ?? d.linkUrl ?? '',
  seller: d.storeName ?? d.mallName ?? d.sellerName ?? d.store?.name ?? d.mall?.name ?? '',
  soldOut: d.soldOut === true || isSoldOutText(d.soldOutText),
});

// 從 HTML 裡的 window.rawData 抽商品卡；沒有 rawData 或找不到 goodsList 回傳 null
export function rawDataFromHtml(html) {
  const text = String(html ?? '');
  const start = text.indexOf('window.rawData=');
  if (start < 0) return null;
  const from = start + 'window.rawData='.length;
  let end = text.indexOf(';document.dispatchEvent', from);
  if (end < 0) end = text.indexOf('</script>', from);
  if (end < 0) return null;
  try {
    return JSON.parse(text.slice(from, end));
  } catch {
    return null;
  }
}

export function cardsFromRawData(raw) {
  const list = findGoodsList(raw, 0, new Set());
  return list ? list.map(it => cardFromGoods(it?.data ?? it)).filter(c => c.goodsId != null) : null;
}

const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const attr = (chunk, name) => decode(chunk.match(new RegExp(name + '="([^"]*)"'))?.[1] ?? '');

// 某個 data-type 區塊裡的第一個價格（當前價、劃線價都用這個抓）
function priceAfter(chunk, marker) {
  const i = chunk.indexOf(marker);
  if (i < 0) return '';
  return chunk.slice(i, i + 1200).match(/(?:US)?\$\s*[\d,]+(?:\.\d{1,2})?/)?.[0] ?? '';
}

// DOM 備援：把 HTML 裡每個連到 -g-<id>.html 的 <a> 當一張卡（卡片內容不巢狀 <a>）
export function parseDom(html) {
  const text = String(html ?? '');
  const cards = [];
  const re = /<a\b[^>]*href="([^"]*-g-(\d+)\.html[^"]*)"[^>]*>/gi;
  for (let m; (m = re.exec(text));) {
    const id = m[2];
    const end = text.indexOf('</a>', m.index);
    const chunk = text.slice(m.index, end > 0 ? end : Math.min(text.length, m.index + 20000));
    const imgAlt = chunk.match(/<img\b[^>]*\balt="([^"]*)"/i)?.[1] ?? '';
    const h3 = chunk.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '';
    const seller = chunk.match(/class="[^"]*(?:storeName|mallName|sellerName)[^"]*"[^>]*>([^<]+)/i)?.[1] ?? '';
    cards.push({
      goodsId: id,
      title: attr(chunk, 'data-tooltip-title') || decode(imgAlt) || decode(h3.replace(/<span class="srOnly[^>]*>[\s\S]*?<\/span>/gi, '')).replace(/<[^>]*>/g, '').trim(),
      priceStr: priceAfter(chunk, 'data-type="price"'),
      marketPriceStr: priceAfter(chunk, 'data-type="marketPrice"'),
      url: m[1],
      seller: decode(seller).trim(),
      soldOut: isSoldOutText(chunk),
    });
  }
  return parseCards(cards);
}

// 先試頁面內嵌 JSON，再退回 DOM。給離線測試 / ingest 用。
export function parseHtml(html) {
  const cards = cardsFromRawData(rawDataFromHtml(html));
  return cards?.length ? parseCards(cards) : parseDom(html);
}

// 頁面內執行的抽取程式：優先用 rawData 的 goodsList，沒有才掃 DOM。回傳頁面狀態一起判斷是否被擋。
const PAGE_SNAPSHOT = String.raw`(() => {
  const soldOutRe = /sold\s*out|out\s*of\s*stock|已售完|售完|售罄/i;
  const isSoldOut = t => soldOutRe.test(String(t || '').replace(/即將\s*(?:售罄|售完)/g, ''));
  const asCard = d => ({
    goodsId: String(d.goodsId),
    title: d.title || d.goodsName || '',
    priceStr: (d.priceInfo && (d.priceInfo.priceStr || d.priceInfo.showPriceStrValue)) || '',
    priceCents: d.priceInfo ? d.priceInfo.price : null,
    marketPriceStr: d.priceInfo ? (d.priceInfo.marketPriceStr || '') : '',
    marketPriceCents: d.priceInfo ? d.priceInfo.marketPrice : null,
    url: d.seoLinkUrl || d.linkUrl || '',
    seller: d.storeName || d.mallName || d.sellerName || (d.store && d.store.name) || '',
    soldOut: d.soldOut === true || isSoldOut(d.soldOutText || ''),
  });
  const seen = new WeakSet();
  const findList = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 8 || seen.has(o)) return null;
    seen.add(o);
    if (!Array.isArray(o) && Array.isArray(o.goodsList) && o.goodsList.some(i => ((i && i.data ? i.data : i) || {}).goodsId != null)) return o.goodsList;
    for (const k of Object.keys(o)) {
      const hit = findList(o[k], depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  // 已知結構先走直達路徑，避免在 rawData 其他分支（mobx 內部狀態）裡亂逛
  const knownList = s => {
    const map = s && s.componentSsrDataMap;
    if (!map) return null;
    for (const k of Object.keys(map)) {
      const v = map[k];
      if (v && Array.isArray(v.goodsList)) return v.goodsList;
    }
    return null;
  };
  const cards = [];
  try {
    const r = window.rawData || {};
    const list = knownList(r.stores && r.stores.store) || knownList(r.store) || findList(r, 0);
    if (list) for (const it of list) {
      const d = it && it.data ? it.data : it;
      if (!d || d.goodsId == null) continue;
      const card = asCard(d);
      if (card.priceStr || card.priceCents != null) cards.push(card);
    }
  } catch (e) {}
  if (!cards.length) {
    for (const a of document.querySelectorAll('a[href*="-g-"]')) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/-g-(\d+)\.html/);
      if (!m) continue;
      const box = a.querySelector('[data-id="goods-card-container"]') || a;
      const priceEl = box.querySelector('[data-type="price"]');
      const marketEl = box.querySelector('[data-type="marketPrice"]');
      const img = box.querySelector('img[alt]');
      const h3 = box.querySelector('h3');
      cards.push({
        goodsId: m[1],
        title: String(box.getAttribute('data-tooltip-title') || a.getAttribute('title') || (img && img.alt) || (h3 && h3.textContent) || '').trim(),
        priceStr: priceEl ? priceEl.textContent : '',
        marketPriceStr: marketEl ? marketEl.textContent : '',
        url: href,
        seller: (box.querySelector('[class*="storeName"],[class*="mallName"],[class*="sellerName"]') || {}).textContent || '',
        soldOut: isSoldOut(box.innerText),
      });
    }
  }
  return { href: location.href, title: document.title, text: ((document.body && document.body.innerText) || '').slice(0, 800), cards: cards };
})()`;

// 商品頁：rawData 裡找 goodsId 相符的物件；找不到就靠 og meta / 主要購買按鈕
const productSnapshot = id => String.raw`(() => {
  const want = ${JSON.stringify(String(id))};
  const soldOutRe = /sold\s*out|out\s*of\s*stock|已售完|售完|售罄/i;
  const isSoldOut = t => soldOutRe.test(String(t || '').replace(/即將\s*(?:售罄|售完)/g, ''));
  const seen = new WeakSet();
  const findGoods = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 9 || seen.has(o)) return null;
    seen.add(o);
    if (String(o.goodsId) === want && (o.title || o.goodsName || o.priceInfo)) return o;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v && typeof v === 'object') {
        const hit = findGoods(v, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  const meta = n => {
    const el = document.querySelector('meta[property="' + n + '"]');
    return el ? el.content : '';
  };
  let d = null, card = null;
  try { d = findGoods(window.rawData, 0); } catch (e) {}
  if (d) card = {
    goodsId: want,
    title: d.title || d.goodsName || '',
    priceStr: (d.priceInfo && (d.priceInfo.priceStr || d.priceInfo.showPriceStrValue)) || '',
    priceCents: d.priceInfo ? d.priceInfo.price : null,
    marketPriceStr: d.priceInfo ? (d.priceInfo.marketPriceStr || '') : '',
    marketPriceCents: d.priceInfo ? d.priceInfo.marketPrice : null,
    url: d.seoLinkUrl || location.href,
    seller: d.storeName || d.mallName || d.sellerName || (d.store && d.store.name) || '',
    soldOut: d.soldOut === true || isSoldOut(d.soldOutText || ''),
  };
  if (!card) {
    const priceEl = document.querySelector('[data-type="price"]');
    const marketEl = document.querySelector('[data-type="marketPrice"]');
    const del = document.querySelector('del, s');
    const h1 = document.querySelector('h1');
    const buttons = [].slice.call(document.querySelectorAll('button,[role="button"]')).map(b => String(b.innerText || '').trim());
    card = {
      goodsId: want,
      title: String(meta('og:title') || (h1 && h1.innerText) || document.title.replace(/\s*[|｜-]\s*Temu.*$/, '')).trim(),
      priceStr: meta('product:price:amount') || (priceEl && priceEl.textContent) || '',
      marketPriceStr: (marketEl && marketEl.textContent) || (del && del.textContent) || '',
      url: meta('og:url') || location.href,
      seller: '',
      soldOut: buttons.some(t => /^(售罄|已售完|sold out|out of stock)$/i.test(t)),
    };
  }
  return { href: location.href, title: document.title, text: ((document.body && document.body.innerText) || '').slice(0, 800), card: card };
})()`;

// 被導到登入頁或人機驗證頁時回傳 'login' / 'verify'
function blockKind({ href = '', title = '', text = '' } = {}) {
  if (/bgn_verification|\/verify|captcha|risk[-_]?(?:check|verify)/i.test(href)) return 'verify';
  if (/安全驗證|人機驗證|請完成驗證|拖動滑塊|captcha/i.test(`${title} ${text}`)) return 'verify';
  if (/\/login\.html/i.test(href) || /(?:^|[|｜]\s*)(登入|log\s*in|sign\s*in)/i.test(title)) return 'login';
  return '';
}

// 載入一頁並抽出資料。被擋就丟 Blocked，並把視窗留著、帶到最前面等使用者處理。
async function load(url, expression, until) {
  if (!browser) throw new Error(NEED_BROWSER);
  const snap = await browser.evaluate(url, expression, { until, timeout: 15000 });
  if (!snap || typeof snap !== 'object') throw new RequestError('Temu 頁面讀取失敗（沒有回傳頁面狀態）', 'format');
  const blocked = blockKind(snap);
  if (blocked) {
    browser.keepOpen = browser.hold = true;
    await browser.focus();
    throw new Blocked(blocked === 'login' ? LOGIN_HINT : VERIFY_HINT);
  }
  browser.hold = false; // 這頁正常，閒置時可以換回空白頁
  return snap;
}

const ready = v => !!v && (blockKind(v) !== '' || (Array.isArray(v.cards) && v.cards.length > 0));
const found = v => !!v && (blockKind(v) !== '' || (v.card && (v.card.priceStr || v.card.priceCents != null || v.card.soldOut)));

// minPrice / maxPrice 沒有確認 Temu 的搜尋網址支援哪個參數，這裡不帶；monitor 的分類條件會再過濾一次。
export async function search({ query = '' } = {}) {
  const snap = await load(searchUrl(query), PAGE_SNAPSHOT, ready);
  const items = parseCards(snap.cards);
  return { total: items.length, items };
}

export async function product(goodsId) {
  const id = String(goodsId ?? '').trim();
  if (!browser) throw new Error(NEED_BROWSER);
  if (!/^\d+$/.test(id)) return [];
  const snap = await load(productUrl(id), productSnapshot(id), found);
  return parseCards(snap.card ? [snap.card] : []).filter(item => item.id === id);
}
