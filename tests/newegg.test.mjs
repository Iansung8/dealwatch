// Newegg 模組的離線測試：用假的 fetchImpl 餵入縮小過的搜尋頁／商品頁 initialState。
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { search, product, initialState, searchUrl, productUrl, configure, usingBrowser, cartItemNumber } from '../src/newegg.mjs';
import { Blocked, RequestError, setPace } from '../src/http.mjs';
import { evaluate } from '../src/specs.mjs';
import config from '../config.mjs';

const read = name => fs.readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const searchState = JSON.parse(read('newegg-search.json'));
const productState = JSON.parse(read('newegg-product.json'));

const page = data => `<!doctype html><html><head><title>Newegg</title></head><body><script>window.__initialState__ = ${JSON.stringify(data)}</script></body></html>`;
const searchHtml = page(searchState);
const productHtml = page(productState);

// 測試不照正式限流間隔排隊
beforeEach(() => setPace('ne', 2, 0));

function mock(body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (typeof body === 'function') return body(url, init);
    return body instanceof Response ? body : new Response(body);
  };
  return { calls, fetchImpl };
}

const searchOnce = async (opts = {}, body = searchHtml, httpOptions = {}) => {
  const m = mock(body);
  const result = await search({ query: 'rtx 5080', ...opts }, { fetchImpl: m.fetchImpl, ...httpOptions });
  return { ...result, calls: m.calls };
};

test('從搜尋頁 __initialState__ 取出 Products，total 用 TotalItemCount', async () => {
  const result = await searchOnce();
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].url, 'https://www.newegg.com/p/pl?d=rtx+5080');
  // http.mjs 的 ne 標頭要原樣套上
  assert.match(result.calls[0].init.headers['user-agent'], /Mozilla/);
  assert.equal(result.total, 42);
  assert.deepEqual(result.items.map(i => i.key), [
    'ne:N82E16814137782',
    'ne:9SIA2W0M3W9692',
    'ne:N82E16834236436',
    'ne:N82E16819113877',
    'ne:N82E16883289001',
    'ne:N82E16820242892',
    'ne:9SIA0000AA0001',
    'ne:N82E16814100001',
  ]);
});

test('自營（Newegg / Newegg.com / null）與第三方賣家；只有自營有 cartUrl', async () => {
  const { items } = await searchOnce();
  const byId = new Map(items.map(i => [i.id, i]));
  assert.equal(byId.get('N82E16814137782').seller, 'Newegg');
  assert.equal(byId.get('N82E16814137782').cartUrl, 'https://secure.newegg.com/Shopping/AddtoCart.aspx?Submit=ADD&ItemList=N82E16814137782');
  assert.equal(byId.get('9SIA2W0M3W9692').seller, 'EPOWERHOUSE');
  assert.equal(byId.get('9SIA2W0M3W9692').cartUrl, null);
  // Seller: null 視為自營
  assert.equal(byId.get('N82E16834236436').seller, 'Newegg');
  assert.ok(byId.get('N82E16834236436').cartUrl);
  // SellerName 是 Newegg.com 也算自營
  assert.equal(byId.get('N82E16820242892').seller, 'Newegg');
  // 缺 Seller 欄位不要丟例外
  assert.equal(byId.get('9SIA0000AA0001').seller, 'Newegg');
});

test('kind / cond 判斷：全新、open-box、整新', async () => {
  const { items } = await searchOnce();
  const byId = new Map(items.map(i => [i.id, i]));
  assert.deepEqual([byId.get('N82E16814137782').kind, byId.get('N82E16814137782').cond], ['new', 'New']);
  assert.deepEqual([byId.get('N82E16834236436').kind, byId.get('N82E16834236436').cond], ['ob', 'Open-Box']);
  assert.deepEqual([byId.get('N82E16819113877').kind, byId.get('N82E16819113877').cond], ['refurb', 'Refurb']);
});

test('原價：OriginalUnitPrice 優先，UnitCost 大於售價時才當原價', async () => {
  const { items } = await searchOnce();
  const byId = new Map(items.map(i => [i.id, i]));
  assert.equal(byId.get('N82E16814137782').price, 1099.99);
  assert.equal(byId.get('N82E16814137782').ref, 1299.99);
  assert.equal(byId.get('9SIA2W0M3W9692').ref, 999.99);
  // UnitCost 等於售價，不是原價
  assert.equal(byId.get('N82E16834236436').ref, undefined);
  assert.equal(byId.get('N82E16820242892').ref, undefined);
});

test('網址組法：有 UrlKeywords 走 /<slug>/p/<Item>，沒有就走 /p/<Item>', async () => {
  const { items } = await searchOnce();
  const byId = new Map(items.map(i => [i.id, i]));
  assert.equal(byId.get('N82E16814137782').url, 'https://www.newegg.com/asus-tuf-gaming-geforce-rtx-5080-16gb-gddr7-oc-edition/p/N82E16814137782');
  assert.equal(byId.get('N82E16883289001').url, 'https://www.newegg.com/p/N82E16883289001');
  assert.equal(productUrl(' N82E16814137782 '), 'https://www.newegg.com/p/N82E16814137782');
  assert.equal(searchUrl('rtx 5080 & more'), 'https://www.newegg.com/p/pl?d=rtx+5080+%26+more');
});

test('售完：Instock false 或 Active false 都算沒貨；缺欄位視為有貨', async () => {
  const { items } = await searchOnce();
  const byId = new Map(items.map(i => [i.id, i]));
  assert.equal(byId.get('N82E16814137782').inStock, true);
  assert.equal(byId.get('N82E16820242892').inStock, false);
  assert.equal(byId.get('N82E16814100001').inStock, false);
  // 贊助／組合包缺 Instock、Active 不要因此被當成沒貨
  assert.equal(byId.get('9SIA0000AA0001').inStock, true);
});

test('minPrice / maxPrice 在本地過濾，total 仍回報網站總數', async () => {
  const { items, total } = await searchOnce({ minPrice: 500, maxPrice: 1600 });
  assert.equal(total, 42);
  assert.deepEqual(items.map(i => i.price), [1099.99, 899.99, 1599.99, 799.99]);
});

test('驗證頁（200）丟 Blocked；403 也丟 Blocked', async () => {
  for (const html of ['<title>Just a moment...</title>', '<body>Are you a human?</body>', '<div id="captcha"></div>']) {
    await assert.rejects(searchOnce({}, html), err => err instanceof Blocked && err.code === 'blocked');
  }
  await assert.rejects(searchOnce({}, new Response('forbidden', { status: 403 })), err => err instanceof Blocked && err.status === 403);
});

test('找不到 initialState 或 JSON 壞掉丟 RequestError(format)；其他 HTTP 錯誤照狀態碼', async () => {
  await assert.rejects(searchOnce({}, '<html><body>沒有資料</body></html>'), err =>
    err instanceof RequestError && err.code === 'format' && /找不到 __initialState__/.test(err.message));
  await assert.rejects(searchOnce({}, '<script>window.__initialState__ = {oops}</script>'), err =>
    err instanceof RequestError && err.code === 'format' && /格式不符/.test(err.message));
  await assert.rejects(searchOnce({}, new Response('boom', { status: 500 })), err =>
    err instanceof RequestError && err.code === 'http' && err.status === 500);
});

test('查無結果回 { total: 0, items: [] }，不是錯誤', async () => {
  for (const state of [{ TotalItemCount: 0, Products: [] }, { TotalItemCount: 0 }, { Products: [] }]) {
    const result = await searchOnce({}, page(state));
    assert.equal(result.total, 0);
    assert.deepEqual(result.items, []);
  }
});

test('頁面裡另一段提到 __initialState__ 的 JS 不會被誤抓', () => {
  const html = `<script>window.__initialState__ = null;</script>
    <script>if (window.__initialState__) console.log(window.__initialState__);</script>
    <script>window.__initialState__ = {"Products": [], "TotalItemCount": 0};</script>`;
  assert.deepEqual(initialState(html), { Products: [], TotalItemCount: 0 });
  // 分號與換行不影響
  assert.deepEqual(initialState('<script>window.__initialState__ = {"a":1};\n</script>'), { a: 1 });
});

test('type 讓五個分類都能比對', async () => {
  const { items } = await searchOnce();
  const byId = new Map(items.map(i => [i.id, i]));
  const cases = [
    ['gpu', 'N82E16814137782', /graphics card|video card|gpu/i],
    ['laptop', 'N82E16834236436', /laptop|notebook/i],
    ['desktop', 'N82E16883289001', /desktop|gaming pc|tower/i],
    ['cpu', 'N82E16819113877', /processor|cpu/i],
    ['ram', 'N82E16820242892', /memory|ram/i],
  ];
  for (const [cat, id, pattern] of cases) {
    const item = byId.get(id);
    assert.match(item.type, pattern, `${cat} 的 type 應可比對`);
    assert.ok(evaluate(config.categories[cat], item), `${cat} 應符合 ${cat} 分類`);
  }
});

test('product 解析商品頁的 ItemDetail（含 ItemInfo 包一層）', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(productHtml); };
  try {
    const items = await product('N82E16814137782');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://www.newegg.com/p/N82E16814137782');
    assert.equal(items.length, 1);
    const item = items[0];
    assert.equal(item.key, 'ne:N82E16814137782');
    assert.equal(item.name, 'ASUS TUF Gaming GeForce RTX 5080 16GB GDDR7 OC Edition');
    assert.equal(item.price, 1099.99);
    assert.equal(item.ref, 1299.99);
    assert.equal(item.seller, 'Newegg');
    assert.equal(item.kind, 'new');
    assert.equal(item.inStock, true);
    assert.equal(item.url, 'https://www.newegg.com/asus-tuf-gaming-geforce-rtx-5080-16gb-gddr7-oc-edition/p/N82E16814137782');
  } finally {
    globalThis.fetch = original;
  }
});

test('product 找不到商品或沒有 ItemDetail 回 []', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(page({}));
    assert.deepEqual(await product('N82E16800000000'), []);
    globalThis.fetch = async () => new Response(page({ ItemDetail: {} }));
    assert.deepEqual(await product('N82E16800000000'), []);
  } finally {
    globalThis.fetch = original;
  }
});

test('加入購物車要用完整的 N82E 編號；未驗證過的格式不給連結', () => {
  assert.equal(cartItemNumber('20-982-099'), 'N82E16820982099');
  assert.equal(cartItemNumber('n82e16814137782'), 'N82E16814137782');
  assert.equal(cartItemNumber('1FT-000M-00474'), null);
  assert.equal(cartItemNumber('9SIA2W0M3W9692'), null);
});

test('直接請求被 Cloudflare 擋就改用瀏覽器，之後同一段時間直接走瀏覽器', async () => {
  let httpCalls = 0, browserCalls = 0;
  const fetchImpl = async () => { httpCalls++; return new Response('<title>Just a moment...</title>', { status: 403 }); };
  const browser = { html: async () => { browserCalls++; return searchHtml; }, focus: async () => {} };
  configure({ browser });
  try {
    const first = await search({ query: 'rtx' }, { fetchImpl });
    assert.ok(first.items.length > 0);
    assert.equal(usingBrowser(), true);
    await search({ query: 'rtx' }, { fetchImpl });
    assert.equal(httpCalls, 1);
    assert.equal(browserCalls, 2);
  } finally { configure({}); }
});

test('瀏覽器裡也跳驗證時保留頁面、帶到最前面並丟 Blocked', async () => {
  let focused = false;
  const browser = { html: async () => '<div>Are you a human?</div>', focus: async () => { focused = true; } };
  configure({ browser });
  try {
    const fetchImpl = async () => new Response('blocked', { status: 403 });
    await assert.rejects(search({ query: 'rtx' }, { fetchImpl }), err => err instanceof Blocked && /瀏覽器/.test(err.message));
    assert.equal(browser.hold, true);
    assert.equal(focused, true);
  } finally { configure({}); }
});
