// Slickdeals：關鍵字搜尋的 RSS。商品在別家店賣，seller 是那家店。
// 介面（src/monitor.mjs 會呼叫）：search({ query, minPrice, maxPrice }, httpOptions) -> { total, items }
import config from '../config.mjs';
import { get, Blocked, requireSuccess } from './http.mjs';
import {
  xmlTag, decodeEntities, cleanText, cleanName, stripUtm, isoDate,
  slickdealsPrice, originalPrice, kindOf, inStockOf, typeOf, bracketOf,
  sellerFromTitle, sellerFromText, storeFromSlug,
} from './feed.mjs';

const ENDPOINT = 'https://slickdeals.net/newsearch.php';
const MAX_AGE_HOURS = config.feeds?.maxAgeHours ?? 48;

export function searchUrl(query) {
  return `${ENDPOINT}?q=${encodeURIComponent(query ?? '')}&searcharea=deals&searchin=first&rss=1`;
}

export async function search({ query, minPrice, maxPrice, maxAgeHours } = {}, httpOptions) {
  const response = await get('sd', searchUrl(query), httpOptions);
  requireSuccess('Slickdeals', response);
  const items = parse(response.body ?? '').filter(item => isFresh(item, maxAgeHours));
  return {
    total: items.length,
    items: items.filter(item => (minPrice == null || item.price >= minPrice) && (maxPrice == null || item.price <= maxPrice)),
  };
}

function isFresh(item, maxAgeHours) {
  return Date.now() - Date.parse(item.postedAt) <= (maxAgeHours ?? MAX_AGE_HOURS) * 36e5;
}

function parse(body) {
  const blocks = [...body.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)].map(match => match[1]);
  // 完全沒有 item：合法但空的 feed 回空陣列，HTML 驗證頁則視為被擋
  if (!blocks.length) {
    if (!/<rss[\s>]/i.test(body) || /<!doctype\s+html|<html[\s>]|<body[\s>]/i.test(body)) {
      throw new Blocked('Slickdeals 擋下請求（驗證頁）');
    }
    return [];
  }
  return blocks.map(parseItem).filter(Boolean);
}

function parseItem(block) {
  const rawTitle = xmlTag(block, 'title');
  if (!rawTitle) return undefined;
  const title = cleanText(rawTitle);
  // 解析不出價格的貼文（抽獎、活動）直接丟掉
  const price = slickdealsPrice(title);
  if (!(price > 0)) return undefined;
  const url = stripUtm(xmlTag(block, 'link'));
  const id = /\/f\/(\d+)/.exec(url)?.[1];
  if (!id) return undefined;
  const postedAt = isoDate(xmlTag(block, 'pubDate'));
  if (!postedAt) return undefined;

  const content = decodeEntities(xmlTag(block, 'content:encoded'));
  const description = decodeEntities(xmlTag(block, 'description'));
  const slug = /data-store-slug="([^"]+)"/i.exec(content)?.[1] ?? /data-store-slug="([^"]+)"/i.exec(description)?.[1];
  const seller = sellerFromTitle(title) || storeFromSlug(slug) || sellerFromText(description) || 'Unknown';
  const { kind, cond } = kindOf(title);
  const score = Number.parseInt(/Thumb Score:\s*([+-]?\d+)/i.exec(content)?.[1] ?? '', 10);

  return {
    store: 'sd',
    id,
    key: `sd:${id}`,
    kind,
    cond,
    name: cleanName(title, seller),
    type: typeOf(title, bracketOf(title)),
    seller,
    price,
    ref: originalPrice(title, price),
    inStock: inStockOf(title),
    url,
    // Slickdeals 的 link 就是討論串，沒有另外的商品網址
    thread: url,
    postedAt,
    ...(Number.isFinite(score) ? { score } : {}),
    cartUrl: null,
  };
}
