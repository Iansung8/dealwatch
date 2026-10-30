import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as temu from '../src/temu.mjs';
import { Blocked } from '../src/http.mjs';

const fixture = name => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

// 假的 Browser：evaluate 直接回傳我們指定的頁面快照，並記錄網址與是否被帶到最前面
function fakeBrowser(snapshot) {
  return {
    hold: false, keepOpen: false, focused: 0, url: '', until: null,
    async evaluate(url, expression, options) { this.url = url; this.until = options?.until; return snapshot; },
    async focus() { this.focused++; },
  };
}

test('價格解析支援貨幣符號、千分位與分段顯示', () => {
  assert.equal(temu.parsePrice('$1,234.56'), 1234.56);
  assert.equal(temu.parsePrice('US$1,234'), 1234);
  assert.equal(temu.parsePrice('$12.34$12.34'), 12.34);
  assert.equal(temu.parsePrice('原價$25.96$25.96'), 25.96);
  assert.equal(temu.parsePrice(9.99), 9.99);
  assert.equal(temu.parsePrice('free shipping'), undefined);
  assert.equal(temu.parsePrice('$0.00'), undefined);
});

test('商品卡正規化：美分、原價規則、售完與缺價', () => {
  const items = temu.parseCards([
    { goodsId: '1001', title: 'A', priceCents: 1357, marketPriceCents: 1988, url: '/us-zh-Hant/a-g-1001.html' },
    { goodsId: '1002', title: 'B', priceStr: '$9.99', marketPriceStr: 'US$9.99' }, // 原價沒有比較高，不給 ref
    { goodsId: '1003', title: 'C', priceStr: '$5.00', soldOut: true },
    { goodsId: '1004', title: 'D' }, // 解析不出價格
    { goodsId: 'bad', title: 'E', priceStr: '$1' },
    { goodsId: '1001', title: '重複', priceStr: '$99' },
  ]);
  assert.equal(items.length, 3);
  const [a, b, c] = items;
  assert.equal(a.store, 'tm');
  assert.equal(a.key, 'tm:1001');
  assert.equal(a.kind, 'new');
  assert.equal(a.cond, 'New');
  assert.equal(a.price, 13.57);
  assert.equal(a.ref, 19.88);
  assert.equal(a.seller, 'Temu');
  assert.equal(a.cartUrl, null);
  assert.equal(a.url, 'https://www.temu.com/a-g-1001.html');
  assert.equal(b.ref, undefined);
  assert.equal(c.inStock, false);
  assert.equal(c.ref, undefined);
  assert.equal(c.url, 'https://www.temu.com/goods.html?goods_id=1003');
});

test('「即將售罄」是低庫存，不算售完', () => {
  assert.equal(temu.isSoldOutText('即將售罄'), false);
  assert.equal(temu.isSoldOutText('即將售完'), false);
  assert.equal(temu.isSoldOutText('售罄'), true);
  assert.equal(temu.isSoldOutText('已售完'), true);
  assert.equal(temu.isSoldOutText('Sold out'), true);
});

test('DOM 備援解析真實商品卡片段', () => {
  const items = temu.parseDom(fixture('temu-cards.html'));
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(i => [i.id, i.price, i.ref]), [
    ['607499415555734', 13.57, 19.88],
    ['601105239258323', 2.65, 25.96],
  ]);
  assert.match(items[0].name, /18000A/);
  assert.ok(items[0].url.endsWith('-g-607499415555734.html'));
  assert.ok(items[1].url.endsWith('-g-601105239258323.html'));
  assert.equal(items[0].inStock, true);
});

test('DOM 備援辨識售完卡片', () => {
  const html = '<a href="/us-zh-Hant/x-g-123456.html"><div data-id="goods-card-container" data-tooltip-title="Sold out widget">'
    + '<div data-type="price"><span class="srOnly">$9.99</span><div>$9.99</div></div><span>售罄</span></div></a>';
  const [item] = temu.parseDom(html);
  assert.equal(item.id, '123456');
  assert.equal(item.price, 9.99);
  assert.equal(item.inStock, false);
});

test('parseHtml 優先採用頁面內嵌 rawData', () => {
  const cards = JSON.parse(fixture('temu-cards.json'));
  const raw = { stores: { store: { componentSsrDataMap: { x1: { goodsList: cards.map(data => ({ data })) } } } } };
  const html = `<script>window.rawData=${JSON.stringify(raw)};document.dispatchEvent(new Event('x'))</script>` + fixture('temu-cards.html');
  const items = temu.parseHtml(html);
  assert.equal(items.length, 3); // rawData 有 3 筆；只有 DOM 的話是 2 筆
  assert.equal(items[2].price, 4.38);
  assert.equal(items[2].ref, 29.39);
  // seoLinkUrl 的追蹤參數要拿掉，只留 /<slug>-g-<id>.html
  assert.equal(items[2].url, 'https://www.temu.com/15pcs-heavy-duty-non-stick-cookware-protectors-scratch-resistant-pattern-pads-washable-reusable-felt-compatible-with--pans-protects-cookware-durable-non-slip-ideal-for-induction-gas--everyday-kitchen-use-g-606379200840316.html');
});

test('search 用瀏覽器載入搜尋頁並正規化商品', async () => {
  const browser = fakeBrowser({
    href: 'https://www.temu.com/search_result.html?search_key=rtx+5080',
    title: 'RTX 5080 - Temu',
    text: '',
    cards: [{ goodsId: '2001', title: 'RTX 5080 graphics card', priceStr: '$999.00', marketPriceStr: '$1,299.00', url: '/us-zh-Hant/rtx-g-2001.html' }],
  });
  temu.configure({ browser });
  const result = await temu.search({ query: 'rtx 5080', minPrice: 400, maxPrice: 1500 });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].price, 999);
  assert.equal(result.items[0].ref, 1299);
  assert.match(browser.url, /search_result\.html\?search_key=rtx\+5080/);
  assert.equal(browser.hold, false);
});

test('搜尋被導到登入頁時丟 Blocked 並保留視窗', async () => {
  const browser = fakeBrowser({ href: 'https://www.temu.com/login.html?from=x', title: 'Temu | 登入', text: '', cards: [] });
  temu.configure({ browser });
  await assert.rejects(temu.search({ query: 'x' }), err => err instanceof Blocked && /登入/.test(err.message));
  assert.equal(browser.hold, true);
  assert.equal(browser.keepOpen, true);
  assert.equal(browser.focused, 1);
});

test('出現人機驗證時丟 Blocked 並要求手動完成', async () => {
  const browser = fakeBrowser({ href: 'https://www.temu.com/bgn_verification.html?verifyCode=abc', title: '安全驗證', text: '請完成驗證以繼續', cards: [] });
  temu.configure({ browser });
  await assert.rejects(temu.search({ query: 'x' }), err => err instanceof Blocked && /人機驗證/.test(err.message));
  assert.equal(browser.hold, true);
  assert.equal(browser.keepOpen, true);
  assert.equal(browser.focused, 1);
});

test('沒有瀏覽器時明確報錯', async () => {
  temu.configure({});
  await assert.rejects(temu.search({ query: 'x' }), /Temu 需要瀏覽器/);
  await assert.rejects(temu.product('123'), /Temu 需要瀏覽器/);
});

test('product 用 goods_id 載入單一商品並驗證 id', async () => {
  const browser = fakeBrowser({
    href: 'https://www.temu.com/us-zh-Hant/widget-g-3001.html',
    title: 'Widget - Temu',
    text: '',
    card: { goodsId: '3001', title: 'Widget', priceStr: '$19.99', marketPriceStr: '$29.99', url: '/us-zh-Hant/widget-g-3001.html' },
  });
  temu.configure({ browser });
  const [item] = await temu.product('3001');
  assert.equal(item.id, '3001');
  assert.equal(item.key, 'tm:3001');
  assert.equal(item.price, 19.99);
  assert.equal(item.ref, 29.99);
  assert.ok(browser.url.includes('goods_id=3001'));

  // 頁面回來的商品 id 不符（例如被導到推薦商品）時回空陣列
  temu.configure({ browser: fakeBrowser({ href: 'https://www.temu.com/x-g-9999.html', title: 'Temu', text: '', card: { goodsId: '9999', title: 'Other', priceStr: '$1' } }) });
  assert.deepEqual(await temu.product('3001'), []);
});
