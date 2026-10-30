import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDoctorReport, parseDoctorArgs, runtimeChecks } from '../src/doctor.mjs';
import { resetCache as resetWootCache } from '../src/woot.mjs';
import { setPace } from '../src/http.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bb = { data: { search: { numFound: 1, documents: [{ product: { skuId: '1', name: { short: 'Example GPU' }, price: { customerPrice: 500 }, seller: { classification: '1P' } } }] } } };
const wm = { props: { pageProps: { initialData: { searchResult: { itemStacks: [{ items: [{ __typename: 'Product', usItemId: '2', name: 'Example GPU', price: 500 }] }] } } } } };
const html = `<script type="application/json" id='__NEXT_DATA__'>${JSON.stringify(wm)}</script>`;
// 測試不照 Newegg 正式限流間隔排隊
setPace('ne', 2, 0);

test('doctor 使用實際兩站查詢與標頭，各一次，並解析商品', async () => {
  const calls = [];
  const report = await createDoctorReport(parseDoctorArgs([]), { fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response(url.includes('bestbuy') ? JSON.stringify(bb) : html);
  } });
  assert.equal(report.exitCode, 0);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /gateway\/graphql/);
  assert.equal(calls[0].init.headers.referer, 'https://www.bestbuy.com/');
  assert.match(calls[1].url, /walmart\.com\/search/);
  assert.match(calls[1].init.headers.accept, /text\/html/);
  assert.deepEqual(report.checks.filter(c => ['bb', 'wm'].includes(c.name)).map(c => c.items), [1, 1]);
});

test('doctor --store wt 從官網取 key 後查詢 Woot GraphQL', async () => {
  resetWootCache();
  const calls = [];
  const report = await createDoctorReport(parseDoctorArgs(['--store', 'wt']), { fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('cloudfront')) {
      const offer = { Id: 'o', Title: 'Example GPU', Slug: 'example', Site: { Name: 'Computers.Woot' },
        Items: [{ Id: 'i', SalePrice: 500, Attributes: [] }] };
      return new Response(JSON.stringify({ data: { searchOffers: { TotalHits: 1, Offers: [offer] } } }));
    }
    return new Response('<script>window.__WOOT_GQL__ = { url: "https://d24qg5zsx8xdc4.cloudfront.net/graphql", apiKey: "da2-test" };</script>');
  } });
  resetWootCache();
  assert.equal(report.exitCode, 0);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers['x-api-key'], 'da2-test');
  assert.equal(report.checks.at(-1).name, 'wt');
  assert.equal(report.checks.at(-1).status, 'pass');
  assert.equal(report.checks.at(-1).items, 1);
});

test('doctor --store ne 解析 Newegg 搜尋頁的 __initialState__', async () => {
  const calls = [];
  const state = { TotalItemCount: 1, Products: [{ ItemCell: { Item: 'N82E16814137782', FinalPrice: 1099.99, Instock: true, Active: true,
    Description: { Title: 'Example GPU' }, Subcategory: { SubcategoryDescription: 'GPUs / Video Graphics Cards' } } }] };
  const report = await createDoctorReport(parseDoctorArgs(['--store', 'ne']), { fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(`<script>window.__initialState__ = ${JSON.stringify(state)}</script>`);
  } });
  assert.equal(report.exitCode, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /newegg\.com\/p\/pl\?d=rtx\+5080/);
  assert.match(calls[0].init.headers.accept, /text\/html/);
  assert.equal(report.checks.at(-1).name, 'ne');
  assert.equal(report.checks.at(-1).status, 'pass');
  assert.equal(report.checks.at(-1).items, 1);
});

test('doctor 把 Newegg 的 Cloudflare 驗證頁判為失敗', async () => {
  const report = await createDoctorReport(parseDoctorArgs(['--store', 'ne']), { fetchImpl: async () => new Response('<title>Just a moment...</title>') });
  assert.equal(report.exitCode, 1);
  assert.equal(report.checks.at(-1).name, 'ne');
  assert.equal(report.checks.at(-1).code, 'blocked');
});

test('doctor offline 完全不發送請求；Node 20 的 WebSocket 缺少是警告', async () => {
  const report = await createDoctorReport(parseDoctorArgs(['--offline']), { version: '20.19.5', webSocketAvailable: false, fetchImpl: () => assert.fail('不應連網') });
  assert.equal(report.exitCode, 0);
  assert.equal(report.checks[1].code, 'browser_unavailable');
  assert.equal(runtimeChecks('18.20.0', false)[0].status, 'fail');
});

test('doctor 將 HTTP 200 的人機驗證判為失敗，且只查選定店家', async () => {
  let calls = 0;
  const report = await createDoctorReport(parseDoctorArgs(['--store', 'wm']), { fetchImpl: async () => { calls++; return new Response('<title>Robot or human?</title>'); } });
  assert.equal(calls, 1);
  assert.equal(report.exitCode, 1);
  assert.equal(report.checks.at(-1).code, 'blocked');
});

test('doctor 不重試失敗請求、不輸出原始錯誤內的機密', async () => {
  let calls = 0;
  const report = await createDoctorReport(parseDoctorArgs(['--store', 'bb']), { fetchImpl: async () => { calls++; throw new Error('SECRET_TOKEN', { cause: { code: 'ENOTFOUND' } }); } });
  assert.equal(calls, 1);
  assert.equal(report.checks.at(-1).code, 'dns');
  assert.ok(!JSON.stringify(report).includes('SECRET_TOKEN'));
});

test('有效空結果標成警告；無法當成商品抓取已驗收', async () => {
  const report = await createDoctorReport(parseDoctorArgs(['--store', 'bb']), { fetchImpl: async () => new Response(JSON.stringify({ data: { search: { documents: [], numFound: 0 } } })) });
  assert.equal(report.checks.at(-1).code, 'empty');
  assert.equal(report.checks.at(-1).status, 'warn');
});

test('選配 CDP 只讀版本端點，不連 WebSocket、不回傳網址', async () => {
  const urls = [];
  const report = await createDoctorReport(parseDoctorArgs(['--store', 'bb', '--cdp-url', 'http://127.0.0.1:9222']), { fetchImpl: async url => {
    urls.push(url);
    return new Response(JSON.stringify(url.endsWith('/json/version') ? { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/secret-session' } : bb));
  } });
  assert.equal(report.checks.at(-1).name, 'cdp');
  assert.equal(report.checks.at(-1).status, 'pass');
  assert.equal(urls.length, 2);
  assert.ok(!JSON.stringify(report).includes('secret-session'));
});

test('參數驗證拒絕錯誤店家、逾時值、URL 帳密與 offline 連網選項', () => {
  assert.deepEqual(parseDoctorArgs(['--store', 'ne']).stores, ['ne']);
  for (const args of [['--store'], ['--store', 'bad'], ['--timeout-ms', '0'], ['--timeout-ms', 'NaN'], ['--secret'], ['--cdp-url', 'http://user:secret@localhost:9222'], ['--offline', '--cdp-url', 'http://localhost:9222']]) {
    assert.throws(() => parseDoctorArgs(args));
  }
});

test('CLI 不讀 .env 或 config，不建立／更動 data；錯誤參數退出碼 2', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dealwatch-doctor-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.cpSync(path.join(root, 'src'), path.join(tmp, 'src'), { recursive: true });
  fs.copyFileSync(path.join(root, 'dealwatch.mjs'), path.join(tmp, 'dealwatch.mjs'));
  fs.writeFileSync(path.join(tmp, 'config.mjs'), 'throw new Error("CONFIG_MUST_NOT_LOAD")');
  fs.writeFileSync(path.join(tmp, '.env'), 'NODE_OPTIONS=SECRET_VALUE\nLINE_TOKEN=SECRET_VALUE');
  const before = fs.readdirSync(tmp).sort();
  const run = args => spawnSync(process.execPath, ['dealwatch.mjs', 'doctor', ...args], { cwd: tmp, encoding: 'utf8', timeout: 5000 });
  const first = run(['--offline', '--json']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).mode, 'offline');
  assert.deepEqual(fs.readdirSync(tmp).sort(), before);
  assert.ok(!first.stdout.includes('SECRET_VALUE'));
  fs.mkdirSync(path.join(tmp, 'data'));
  fs.writeFileSync(path.join(tmp, 'data/state.json'), 'SENTINEL');
  assert.equal(run(['--offline']).status, 0);
  assert.equal(fs.readFileSync(path.join(tmp, 'data/state.json'), 'utf8'), 'SENTINEL');
  const invalid = run(['--store', 'invalid', '--json']);
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).code, 'usage');
});

test('原有 help 指令在其他工作目錄啟動時仍能載入設定與顯示用法', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dealwatch-monitor-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.cpSync(path.join(root, 'src'), path.join(tmp, 'src'), { recursive: true });
  for (const name of ['dealwatch.mjs', 'config.mjs', 'msrp.mjs']) fs.copyFileSync(path.join(root, name), path.join(tmp, name));
  const result = spawnSync(process.execPath, [path.join(tmp, 'dealwatch.mjs'), 'help'], { cwd: os.tmpdir(), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /doctor/);
  assert.match(result.stdout, /notify-test/);
  assert.ok(fs.existsSync(path.join(tmp, 'data')));
});
