// Woot（Amazon 旗下的限時特賣）：走官網前端用的 AppSync GraphQL（GET + 公開的 x-api-key）。
// key 與端點都嵌在官網 HTML 裡，執行時抓一次並快取 6 小時，不寫死在程式碼裡。
// 介面（src/monitor.mjs 會呼叫）：
//   search({ query, minPrice, maxPrice, limit }, httpOptions) -> { total, items }
//   product(slug) -> items        指定商品用，slug 是商品網址 /offers/<slug> 那一段
//   offerUrl(siteName, slug) -> 商品頁網址
// items 的格式跟 src/bestbuy.mjs / src/walmart.mjs 的 normalize 一樣（store: 'wt'）。
import { get, RequestError, requireSuccess } from './http.mjs';

const HOME = 'https://www.woot.com/category/computers';
const API_TTL = 6 * 36e5;
const PAGE = 60; // 每頁向 GraphQL 要幾筆 Offer

const OFFER_FIELDS = 'Id Title Slug SoldOut EndDate Site { Name } IsRefurbished IsFactoryReconditioned Taxonomy { Category CategoryCode CategoryFamily CategoryFamilyCode ProductCategory ProductGroup ProductGroupCode } Tags Items { Id ListPrice SalePrice SoldOut Attributes { Key Value } }';
const SEARCH_QUERY = `query S($filter: OfferFilterInput, $sort: OfferSortInput, $limit: Int, $skip: Int) { searchOffers(Filter: $filter, Sort: $sort, Limit: $limit, Skip: $skip) { TotalHits Offers { ${OFFER_FIELDS} } } }`;
const PRODUCT_QUERY = `query P($slug: String!) { getOfferBySlug(Slug: $slug) { ${OFFER_FIELDS} } }`;

let api = null; // { endpoint, key, t }
let apiJob = null;

// 測試用：清掉 key 快取，讓下一次查詢重新抓官網頁面
export function resetCache() { api = null; apiJob = null; }

async function fetchApi(httpOptions) {
  const response = await get('wt', HOME, httpOptions);
  requireSuccess('Woot', response);
  const key = /apiKey["']?\s*[:=]\s*["'](da2-[A-Za-z0-9]+)["']/.exec(response.body)?.[1];
  const endpoint = /(https:\/\/[a-z0-9.-]+\.cloudfront\.net\/graphql)/i.exec(response.body)?.[1];
  if (!key || !endpoint) throw new RequestError('Woot 頁面格式不符（找不到 API key）', 'format');
  api = { endpoint, key, t: Date.now() };
  return api;
}

function apiInfo(httpOptions, force = false) {
  if (!force && api && Date.now() - api.t < API_TTL) return Promise.resolve(api);
  // 同時多個關鍵字會一起進來，只抓一次官網頁面
  if (!force && apiJob) return apiJob;
  const job = fetchApi(httpOptions);
  if (force) return job;
  apiJob = job.finally(() => { apiJob = null; });
  return apiJob;
}

async function gql(query, variables, httpOptions) {
  let info = await apiInfo(httpOptions);
  for (let attempt = 0; ; attempt++) {
    const url = `${info.endpoint}?query=${encodeURIComponent(query)}${variables ? `&variables=${encodeURIComponent(JSON.stringify(variables))}` : ''}`;
    const response = await get('wt', url, { ...httpOptions, headers: { 'x-api-key': info.key, ...httpOptions?.headers } });
    // key 過期或失效時重抓一次官網頁面再試；第二次仍失敗就照一般錯誤處理
    if (attempt === 0 && (response.status === 401 || response.status === 403 || /UnauthorizedException/.test(response.body))) {
      info = await apiInfo(httpOptions, true);
      continue;
    }
    requireSuccess('Woot', response);
    let json;
    try { json = JSON.parse(response.body); } catch { throw new RequestError('Woot 回應格式不符（預期 JSON）', 'format'); }
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new RequestError('Woot 回應格式不符（預期 JSON 物件）', 'format');
    if (json.errors?.length && !json.data) throw new RequestError(`Woot GraphQL 查詢失敗: ${json.errors[0]?.message ?? '未知錯誤'}`, 'upstream');
    return json.data ?? {};
  }
}

export async function search({ query, minPrice, maxPrice, limit = PAGE } = {}, httpOptions) {
  const items = [];
  let total = 0, offers = 0;
  for (let skip = 0; offers < limit; skip += PAGE) {
    const take = Math.min(PAGE, limit - offers);
    const data = await gql(SEARCH_QUERY, { filter: { Keyword: query }, sort: 'NewestFirst', limit: take, skip }, httpOptions);
    const result = data.searchOffers;
    if (!result) throw new RequestError('Woot 回應缺少 searchOffers', 'format');
    total = result.TotalHits ?? total;
    const batch = result.Offers ?? [];
    offers += batch.length;
    for (const offer of batch) items.push(...normalize(offer));
    // 這一頁不滿就代表沒有下一頁了
    if (batch.length < take) break;
  }
  // 價格條件在本地過濾，避免依賴 PriceFilterInputs 的實際語意
  return {
    total,
    items: items.filter(i => (minPrice == null || i.price >= minPrice) && (maxPrice == null || i.price <= maxPrice)),
  };
}

export async function product(slug) {
  const offer = (await gql(PRODUCT_QUERY, { slug: String(slug) })).getOfferBySlug;
  return offer ? normalize(offer) : [];
}

export function offerUrl(siteName, slug) {
  // Site.Name 像 "Computers.Woot" → computers.woot.com；"Woot" 或沒有值就走 www
  const site = String(siteName ?? '').toLowerCase().replace(/\.woot(?:\.com)?$/, '').trim();
  return site && site !== 'woot' ? `https://${site}.woot.com/offers/${slug}` : `https://www.woot.com/offers/${slug}`;
}

const money = v => {
  const n = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

// Condition 常見值：New / New; Open Box / Refurbished / Factory Reconditioned / Renewed
function conditionOf(offer, item) {
  const raw = (item.Attributes ?? []).find(a => /^condition$/i.test(a.Key ?? ''))?.Value ?? '';
  const s = String(raw).toLowerCase();
  const factory = !!offer.IsFactoryReconditioned || /factory/.test(s);
  // "New; Open Box" 要算 open-box，所以先看 open box 再看 new
  if (/open[\s-]*box/.test(s)) return { kind: 'ob', cond: 'Open-Box' };
  if (/refurb|recondition|used|renewed/.test(s)) return { kind: 'refurb', cond: factory ? 'Factory Recon' : 'Refurb' };
  if (/\bnew\b/.test(s)) return { kind: 'new', cond: 'New' };
  if (offer.IsRefurbished || offer.IsFactoryReconditioned) return { kind: 'refurb', cond: factory ? 'Factory Recon' : 'Refurb' };
  return { kind: 'new', cond: 'New' };
}

// 分類用的 type 字串：Taxonomy 為主，Woot 常把顯卡標成 "Components Other"，再用標題補。
function typeOf(offer, title) {
  const t = offer.Taxonomy ?? {};
  const base = [t.Category, t.CategoryFamily, t.ProductCategory, t.ProductGroup, ...(offer.Tags ?? [])].filter(Boolean).join(' ');
  const hints = [];
  const computer = /laptop|notebook|gaming pc|desktop pc|all-in-one|\bimac\b|mini pc/i.test(title);
  const parts = /motherboard|mainboard/i.test(`${title} ${base}`);
  if (!computer && /(?:geforce|radeon)\b|\b(?:rtx|gtx|rx)[\s-]*\d{3,4}/i.test(title)) hints.push('graphics card');
  if (!computer && !parts && /\bddr[45]\b/i.test(title)) hints.push('memory');
  if (!parts && /\b(?:processor|cpu)\b/i.test(title) && !/food processor/i.test(title)) hints.push('processor');
  return [base, ...hints].filter(Boolean).join(' ');
}

function normalize(offer) {
  if (!offer?.Id) return [];
  const title = offer.Title ?? '';
  const type = typeOf(offer, title);
  const url = offer.Slug ? offerUrl(offer.Site?.Name, offer.Slug) : undefined;
  return (offer.Items ?? []).filter(item => item?.Id != null).map(item => {
    const { kind, cond } = conditionOf(offer, item);
    // 多規格 Offer 靠 Attributes 區分（Model、Size、Color…），標題已經寫過的值就不重複
    const lower = title.toLowerCase();
    const spec = (item.Attributes ?? [])
      .filter(a => a?.Key && a.Value && !/^condition$/i.test(a.Key))
      .map(a => String(a.Value))
      .filter(v => !lower.includes(v.toLowerCase()));
    const sale = money(item.SalePrice);
    const list = money(item.ListPrice);
    return {
      store: 'wt',
      // 表格顯示與指定商品比對用商品網址裡的 slug（同一個 Offer 的各規格共用）；去重用的 key 才分到規格
      id: offer.Slug ?? offer.Id,
      key: `wt:${offer.Id}:${item.Id}`,
      kind,
      cond,
      name: spec.length ? `${title} - ${spec.join(' / ')}` : title,
      type,
      seller: 'Woot',
      price: sale,
      // ListPrice 只有大於售價時才是原價，否則忽略
      ref: list != null && sale != null && list > sale ? list : undefined,
      inStock: !offer.SoldOut && !item.SoldOut,
      offerId: offer.Id,
      slug: offer.Slug,
      endsAt: offer.EndDate,
      url,
      cartUrl: null,
    };
  });
}
