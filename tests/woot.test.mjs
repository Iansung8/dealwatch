// Woot 模組的離線測試：用假的 fetchImpl 模擬官網 HTML 與 AppSync GraphQL。
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { search, offerUrl, resetCache } from '../src/woot.mjs';
import { RequestError } from '../src/http.mjs';
import { evaluate } from '../src/specs.mjs';
import config from '../config.mjs';

const ENDPOINT = 'https://d24qg5zsx8xdc4.cloudfront.net/graphql';
const page = key => `<script>window.__WOOT_GQL__ = { url: "${ENDPOINT}", apiKey: "${key}" };</script>`;

function offer(over = {}) {
  return {
    Id: 'offer-1',
    Title: 'MSI GeForce RTX 5080 16G INSPIRE 3X OC BLACK',
    Slug: 'msi-rtx-5080',
    SoldOut: false,
    EndDate: '2026-11-07T06:00:00Z',
    Site: { Name: 'Computers.Woot' },
    IsRefurbished: false,
    IsFactoryReconditioned: false,
    Taxonomy: { Category: 'Computer Components', CategoryFamily: 'PC', ProductCategory: 'PC', ProductGroup: 'Components Other' },
    Tags: [],
    Items: [{ Id: 'item-1', ListPrice: null, SalePrice: 1649.99, SoldOut: false, Attributes: [{ Key: 'Condition', Value: 'Factory Reconditioned' }] }],
    ...over,
  };
}

const ok = (offers, total = offers.length) => ({ data: { searchOffers: { TotalHits: total, Offers: offers } } });

// 官網 HTML 與 GraphQL 由同一個 fetchImpl 回應；graphql 可以是物件或 (url, init) => 物件/Response
function mock({ key = 'da2-testkey123', html = null, graphql }) {
  let pages = 0;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, headers: init?.headers ?? {} });
    if (u.startsWith('https://d24qg5zsx8xdc4.cloudfront.net/')) {
      const body = typeof graphql === 'function' ? await graphql(u, init) : graphql;
      return body instanceof Response ? body : new Response(JSON.stringify(body));
    }
    pages++;
    return new Response(typeof html === 'function' ? html(pages) : html ?? page(key));
  };
  return { calls, fetchImpl, graphqlCalls: () => calls.filter(c => c.url.includes('cloudfront')) };
}

beforeEach(() => resetCache());

test('從官網 HTML 取得 key 與端點，並帶 x-api-key 查詢', async () => {
  const m = mock({ graphql: ok([offer()]) });
  const result = await search({ query: 'rtx 5080' }, { fetchImpl: m.fetchImpl });
  assert.equal(result.total, 1);
  assert.equal(result.items.length, 1);
  assert.equal(m.calls.length, 2);
  assert.match(m.calls[0].url, /woot\.com\/category\/computers/);
  assert.equal(m.calls[1].headers['x-api-key'], 'da2-testkey123');
  const sent = decodeURIComponent(m.calls[1].url);
  assert.ok(sent.includes('"Keyword":"rtx 5080"'));
  assert.ok(sent.includes('"sort":"NewestFirst"'));
});

test('key 快取後同一個程序內不再重抓官網頁面', async () => {
  const m = mock({ graphql: ok([offer()]) });
  await search({ query: 'a' }, { fetchImpl: m.fetchImpl });
  await search({ query: 'b' }, { fetchImpl: m.fetchImpl });
  assert.equal(m.calls.filter(c => c.url.includes('woot.com/category')).length, 1);
  assert.equal(m.graphqlCalls().length, 2);
});

test('key 失效（401）時重抓一次官網頁面再試', async () => {
  let pages = 0, queries = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).includes('cloudfront')) {
      queries++;
      if (init.headers['x-api-key'] === 'da2-old') return new Response('{"message":"UnauthorizedException"}', { status: 401 });
      return new Response(JSON.stringify(ok([offer()])));
    }
    pages++;
    return new Response(page(pages === 1 ? 'da2-old' : 'da2-new'));
  };
  const result = await search({ query: 'x' }, { fetchImpl });
  assert.equal(pages, 2);
  assert.equal(queries, 2);
  assert.equal(result.items.length, 1);
});

test('GraphQL 回 UnauthorizedException 也重抓一次 key', async () => {
  let queries = 0;
  const fetchImpl = async (url, init) => {
    if (String(url).includes('cloudfront')) {
      queries++;
      if (init.headers['x-api-key'] === 'da2-old') {
        return new Response(JSON.stringify({ data: null, errors: [{ message: 'UnauthorizedException' }] }));
      }
      return new Response(JSON.stringify(ok([offer()])));
    }
    return new Response(page(queries === 0 ? 'da2-old' : 'da2-new'));
  };
  const result = await search({ query: 'x' }, { fetchImpl });
  assert.equal(queries, 2);
  assert.equal(result.items.length, 1);
});

test('SalePrice 是售價；ListPrice 沒有大於售價就忽略', async () => {
  const m = mock({
    graphql: ok([
      offer({ Id: 'o1', Items: [{ Id: 'i1', ListPrice: 1000, SalePrice: 1200, Attributes: [{ Key: 'Condition', Value: 'New' }] }] }),
      offer({ Id: 'o2', Items: [{ Id: 'i2', ListPrice: 1500, SalePrice: 1200, Attributes: [{ Key: 'Condition', Value: 'New' }] }] }),
      offer({ Id: 'o3', Items: [{ Id: 'i3', ListPrice: null, SalePrice: 1200, Attributes: [{ Key: 'Condition', Value: 'New' }] }] }),
    ]),
  });
  const { items } = await search({ query: 'x' }, { fetchImpl: m.fetchImpl });
  assert.deepEqual(items.map(i => [i.id, i.price, i.ref]), [
    ['o1:i1', 1200, undefined],
    ['o2:i2', 1200, 1500],
    ['o3:i3', 1200, undefined],
  ]);
});

test('多規格 Offer 展開成多筆，名稱補上規格屬性', async () => {
  const m = mock({
    graphql: ok([offer({
      Id: 'o',
      Title: 'Dell OptiPlex 7010 Micro Desktop PC (Open Box)',
      Slug: 'dell-optiplex',
      Taxonomy: { Category: 'Desktop', ProductGroup: 'Desktops' },
      Items: [
        { Id: 'a', SalePrice: 552.89, ListPrice: null, Attributes: [{ Key: 'Condition', Value: 'New; Open Box' }, { Key: 'Model', Value: '32GB | 512GB SSD' }, { Key: 'Style', Value: 'Grade A' }] },
        { Id: 'b', SalePrice: 329.79, ListPrice: null, Attributes: [{ Key: 'Condition', Value: 'New; Open Box' }, { Key: 'Model', Value: 'i5 16GB RAM | 512GB SSD' }] },
      ],
    })]),
  });
  const { items } = await search({ query: 'x' }, { fetchImpl: m.fetchImpl });
  assert.deepEqual(items.map(i => i.id), ['o:a', 'o:b']);
  assert.deepEqual(items.map(i => i.key), ['wt:o:a', 'wt:o:b']);
  assert.equal(items[0].name, 'Dell OptiPlex 7010 Micro Desktop PC (Open Box) - 32GB | 512GB SSD / Grade A');
  assert.equal(items[1].name, 'Dell OptiPlex 7010 Micro Desktop PC (Open Box) - i5 16GB RAM | 512GB SSD');
  assert.equal(items[0].offerId, 'o');
  assert.equal(items[0].slug, 'dell-optiplex');
});

test('kind / cond 判斷：New、Open Box、整新、整新翻新', async () => {
  const cases = [
    ['New', 'new', 'New'],
    ['New; Open Box', 'ob', 'Open-Box'],
    ['Refurbished', 'refurb', 'Refurb'],
    ['Factory Reconditioned', 'refurb', 'Factory Recon'],
    ['Renewed', 'refurb', 'Refurb'],
  ];
  for (const [value, kind, cond] of cases) {
    const m = mock({
      graphql: ok([offer({ Items: [{ Id: 'i', SalePrice: 100, Attributes: [{ Key: 'Condition', Value: value }] }] })]),
    });
    const { items } = await search({ query: 'x' }, { fetchImpl: m.fetchImpl });
    assert.equal(items[0].kind, kind, value);
    assert.equal(items[0].cond, cond, value);
  }
});

test('沒有 Condition 時看 IsRefurbished / IsFactoryReconditioned，再退回 New', async () => {
  const refurb = mock({ graphql: ok([offer({ IsFactoryReconditioned: true, Items: [{ Id: 'i', SalePrice: 100 }] })]) });
  assert.equal((await search({ query: 'x' }, { fetchImpl: refurb.fetchImpl })).items[0].kind, 'refurb');
  resetCache();
  const plain = mock({ graphql: ok([offer({ Items: [{ Id: 'i', SalePrice: 100 }] })]) });
  assert.equal((await search({ query: 'x' }, { fetchImpl: plain.fetchImpl })).items[0].kind, 'new');
});

test('售完的商品照樣回傳，inStock 為 false', async () => {
  const m = mock({
    graphql: ok([
      offer({ Id: 'o1', SoldOut: true }),
      offer({ Id: 'o2', Items: [{ Id: 'i', SalePrice: 100, SoldOut: true, Attributes: [{ Key: 'Condition', Value: 'New' }] }] }),
    ]),
  });
  const { items } = await search({ query: 'x' }, { fetchImpl: m.fetchImpl });
  assert.equal(items.length, 2);
  assert.ok(items.every(i => i.inStock === false));
});

test('商品頁網址依 Site.Name 選子網域', async () => {
  assert.equal(offerUrl('Computers.Woot', 'abc'), 'https://computers.woot.com/offers/abc');
  assert.equal(offerUrl('Sellout.Woot', 'abc'), 'https://sellout.woot.com/offers/abc');
  assert.equal(offerUrl('Woot', 'abc'), 'https://www.woot.com/offers/abc');
  assert.equal(offerUrl(null, 'abc'), 'https://www.woot.com/offers/abc');
  const m = mock({ graphql: ok([offer({ Site: { Name: 'Sellout.Woot' }, Slug: 'abc' })]) });
  assert.equal((await search({ query: 'x' }, { fetchImpl: m.fetchImpl })).items[0].url, 'https://sellout.woot.com/offers/abc');
});

test('GraphQL errors 且沒有 data 歸類為 upstream 錯誤', async () => {
  const m = mock({ graphql: { data: null, errors: [{ message: 'Lambda:Unhandled' }] } });
  await assert.rejects(search({ query: 'x' }, { fetchImpl: m.fetchImpl }), err =>
    err instanceof RequestError && err.code === 'upstream' && /Woot GraphQL 查詢失敗: Lambda:Unhandled/.test(err.message));
});

test('找不到 API key 或回應不是 JSON 時歸類為 format 錯誤', async () => {
  await assert.rejects(search({ query: 'x' }, { fetchImpl: async () => new Response('<html>no key</html>') }), err =>
    err instanceof RequestError && err.code === 'format' && err.message === 'Woot 頁面格式不符（找不到 API key）');
  resetCache();
  const m = mock({ graphql: () => new Response('<html>not json</html>') });
  await assert.rejects(search({ query: 'x' }, { fetchImpl: m.fetchImpl }), err =>
    err instanceof RequestError && err.code === 'format');
});

test('type 讓顯卡與筆電分到正確分類', async () => {
  const gpu = offer();
  const laptop = offer({
    Id: 'laptop',
    Title: 'ASUS ROG Zephyrus G16 Ryzen AI 9 RTX 5070 Ti Laptop',
    Site: { Name: 'Computers.Woot' },
    Taxonomy: { Category: 'Laptops', CategoryFamily: 'PC', ProductCategory: 'PC', ProductGroup: 'Laptops' },
    Items: [{ Id: 'i', SalePrice: 1899.99, ListPrice: null, Attributes: [{ Key: 'Condition', Value: 'New' }] }],
  });
  const m = mock({ graphql: ok([gpu, laptop]) });
  const { items } = await search({ query: 'x' }, { fetchImpl: m.fetchImpl });
  const [g, l] = items;
  assert.match(g.type, /graphics card|video card|gpu/i);
  assert.ok(evaluate(config.categories.gpu, g), 'GPU 應符合 gpu 分類');
  assert.match(l.type, /laptop|notebook/i);
  assert.ok(evaluate(config.categories.laptop, l), '筆電應符合 laptop 分類');
});

test('limit 超過一頁時用 Skip 分頁', async () => {
  const many = n => Array.from({ length: n }, (_, i) => offer({
    Id: `o${i}`,
    Items: [{ Id: 'i', SalePrice: 100, Attributes: [{ Key: 'Condition', Value: 'New' }] }],
  }));
  let calls = 0;
  const m = mock({ graphql: () => (++calls === 1 ? ok(many(60)) : ok(many(1))) });
  const { items } = await search({ query: 'x', limit: 61 }, { fetchImpl: m.fetchImpl });
  assert.equal(items.length, 61);
  assert.equal(m.graphqlCalls().length, 2);
  assert.ok(decodeURIComponent(m.graphqlCalls()[1].url).includes('"skip":60'));
});

test('minPrice / maxPrice 在本地過濾', async () => {
  const priced = (id, price) => offer({ Id: id, Items: [{ Id: 'i', SalePrice: price, Attributes: [{ Key: 'Condition', Value: 'New' }] }] });
  const m = mock({ graphql: ok([priced('a', 100), priced('b', 500), priced('c', 900)]) });
  const { items } = await search({ query: 'x', minPrice: 200, maxPrice: 800 }, { fetchImpl: m.fetchImpl });
  assert.deepEqual(items.map(i => i.price), [500]);
});
