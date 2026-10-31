// Reddit r/buildapcsales：最新貼文的 Atom feed。商品在別家店賣，seller 是那家店。
// 介面（src/monitor.mjs 會呼叫）：search({ query, minPrice, maxPrice }, httpOptions) -> { total, items }
//
// Reddit 對未登入的請求限流很嚴（連打兩次就 429），所以：
//   1. 一次抓到的 feed 在記憶體放 60 秒，同一輪 monitor 的所有關鍵字共用。
//   2. 同時進來的呼叫共用同一個進行中的 Promise，只發一個請求。
//   3. 遇到 429 記下 5 分鐘冷卻，期間直接丟 Blocked 讓 monitor 退避。
import config from '../config.mjs';
import { get, Blocked, requireSuccess } from './http.mjs';
import {
  xmlTag, decodeEntities, cleanText, cleanName, isoDate, redditPrice, originalPrice,
  kindOf, inStockOf, typeOf, bracketOf, isCategory, sellerFromTitle, storeFromDomain,
} from './feed.mjs';

const FEED = 'https://www.reddit.com/r/buildapcsales/new/.rss?limit=100';
const CACHE_TTL = 60e3;
const COOLDOWN = 5 * 60e3;
const MAX_AGE_HOURS = config.feeds?.maxAgeHours ?? 48;
const RATE_LIMIT = 'Reddit 限流 (HTTP 429)，稍後再試';

let cache = null; // { t, records }
let job = null; // 進行中的抓取
let blockedUntil = 0;

// 測試用：清掉快取與冷卻
export function resetCache() {
  cache = null;
  job = null;
  blockedUntil = 0;
}

export async function search({ query, minPrice, maxPrice, maxAgeHours } = {}, httpOptions) {
  const records = await load(httpOptions);
  const limit = (maxAgeHours ?? MAX_AGE_HOURS) * 36e5;
  const now = Date.now();
  const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const items = [];
  for (const record of records) {
    if (!(now - Date.parse(record.item.postedAt) <= limit)) continue;
    if (!matches(record, words)) continue;
    if (minPrice != null && record.item.price < minPrice) continue;
    if (maxPrice != null && record.item.price > maxPrice) continue;
    items.push(record.item);
  }
  return { total: items.length, items };
}

// 標題（含開頭方括號）包含 query 的每個字，或方括號分類等於 query
function matches({ title, bracket }, words) {
  if (!words.length) return true;
  if (bracket && bracket.toLowerCase() === words.join(' ')) return true;
  const lower = title.toLowerCase();
  return words.every(word => lower.includes(word));
}

function load(httpOptions) {
  const now = Date.now();
  if (cache && now - cache.t < CACHE_TTL) return Promise.resolve(cache.records);
  if (blockedUntil > now) return Promise.reject(new Blocked(RATE_LIMIT, 429));
  if (job) return job;
  job = fetchFeed(httpOptions)
    .then(records => {
      cache = { t: Date.now(), records };
      return records;
    })
    .finally(() => { job = null; });
  return job;
}

async function fetchFeed(httpOptions) {
  const response = await get('rd', FEED, httpOptions);
  try {
    requireSuccess('Reddit', response);
  } catch (err) {
    if (err instanceof Blocked && err.status === 429) {
      blockedUntil = Date.now() + COOLDOWN;
      throw new Blocked(RATE_LIMIT, 429);
    }
    throw err;
  }
  return parse(response.body ?? '');
}

function parse(body) {
  const blocks = [...body.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)].map(match => match[1]);
  // 完全沒有 entry：合法但空的 feed 回空陣列，HTML 驗證頁則視為被擋
  if (!blocks.length) {
    if (!/<feed[\s>]/i.test(body) || /<!doctype\s+html|<html[\s>]|<body[\s>]/i.test(body)) {
      throw new Blocked('Reddit 擋下請求（驗證頁）');
    }
    return [];
  }
  return blocks.map(parseEntry).filter(Boolean);
}

function parseEntry(block) {
  const title = cleanText(xmlTag(block, 'title'));
  const thread = decodeEntities(/<link\s+href="([^"]+)"/i.exec(block)?.[1] ?? '');
  const id = xmlTag(block, 'id').trim().replace(/^t3_/, '') || /\/comments\/([a-z0-9]+)/i.exec(thread)?.[1];
  if (!id) return undefined;
  const postedAt = isoDate(xmlTag(block, 'published') || xmlTag(block, 'updated'));
  if (!postedAt) return undefined;
  const price = redditPrice(title);
  if (!(price > 0)) return undefined;

  // content 是跳脫過的 HTML，解回來後找 [link] 錨點（實際商品網址）
  const html = decodeEntities(decodeEntities(xmlTag(block, 'content')));
  const product = decodeEntities(/<a\s[^>]*href="([^"]+)"[^>]*>\s*\[link\]\s*<\/a>/i.exec(html)?.[1] ?? '');
  const url = product || thread;

  const bracket = bracketOf(title);
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  // 方括號不是分類就當店名；是分類（[GPU]、[Prebuilt]…）就用商品網址的網域推
  const fromDomain = host && !/(^|\.)reddit\.com$/i.test(host) ? storeFromDomain(host) : '';
  const seller = bracket && !isCategory(bracket) ? bracket : fromDomain || sellerFromTitle(title) || 'Unknown';
  const { kind, cond } = kindOf(title);

  return {
    title,
    bracket,
    item: {
      store: 'rd',
      id,
      key: `rd:${id}`,
      kind,
      cond,
      name: cleanName(title, seller),
      type: typeOf(title, bracket),
      seller,
      price,
      ref: originalPrice(title, price),
      inStock: inStockOf(title),
      url,
      thread,
      postedAt,
      cartUrl: null,
    },
  };
}
