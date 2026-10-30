// 部署前診斷：不載入 config／.env，不建立 data，不啟動監控、瀏覽器或推播。
import * as bestbuy from './bestbuy.mjs';
import * as walmart from './walmart.mjs';
import * as woot from './woot.mjs';
import * as newegg from './newegg.mjs';

const ACTIONS = {
  dns: '檢查 DNS；先用 nslookup 驗證名稱解析。',
  tls: '檢查主機時間與 CA 憑證，維持 TLS 驗證開啟。',
  timeout: '檢查出口與網站回應，稍後低頻重試；curl 的結果只供對照。',
  network: '檢查出口、路由與防火牆。',
  blocked: '停止密集重試，使用一般瀏覽器檢查；驗證由使用者完成。',
  http: '檢查 HTTP 狀態與商店服務是否暫時異常。',
  format: '網站回應結構可能已改變，檢查解析器。',
  upstream: '商店查詢介面回報錯誤，檢查 GraphQL 結構。',
};

export function runtimeChecks(version = process.versions.node, webSocketAvailable = typeof globalThis.WebSocket === 'function') {
  const supported = Number(version.split('.')[0]) >= 20;
  return [
    { name: 'node', status: supported ? 'pass' : 'fail', code: supported ? 'ok' : 'runtime', message: `Node.js ${version}；直接 HTTP 診斷需要 20 以上。` },
    { name: 'websocket', status: webSocketAvailable ? 'pass' : 'warn', code: webSocketAvailable ? 'ok' : 'browser_unavailable', message: webSocketAvailable ? '內建 WebSocket 可用；尚未驗證瀏覽器啟動。' : '內建 WebSocket 不可用；HTTP 診斷仍可執行，瀏覽器模式請用 Node.js 22 以上。' },
  ];
}

export function parseDoctorArgs(args) {
  const options = { offline: false, json: false, stores: ['bb', 'wm'], timeout: 12000, cdpUrl: '' };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--offline') options.offline = true;
    else if (key === '--json') options.json = true;
    else if (key === '--help') options.help = true;
    else if (['--store', '--timeout-ms', '--cdp-url'].includes(key)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${key} 需要值`);
      if (key === '--store') {
        if (!['bb', 'wm', 'wt', 'ne'].includes(value)) throw new Error('--store 必須是 bb、wm、wt 或 ne');
        options.stores = [value];
      } else if (key === '--timeout-ms') {
        const timeout = Number(value);
        if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000) throw new Error('--timeout-ms 必須是 100–30000 的整數');
        options.timeout = timeout;
      } else {
        let url;
        try { url = new URL(value); } catch { throw new Error('--cdp-url 必須是有效 HTTP(S) 網址'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('--cdp-url 請提供沒有帳密、路徑或查詢參數的 HTTP(S) 主機網址');
        options.cdpUrl = url.origin;
      }
    } else throw new Error('doctor 選項不支援；使用 --help 查看用法');
  }
  if (options.offline && options.cdpUrl) throw new Error('--offline 與 --cdp-url 不能同時使用');
  return options;
}

export async function createDoctorReport(options, { fetchImpl = globalThis.fetch, version = process.versions.node, webSocketAvailable = typeof globalThis.WebSocket === 'function' } = {}) {
  const checks = runtimeChecks(version, webSocketAvailable);
  if (!options.offline && checks[0].status === 'pass') {
    const httpOptions = { timeout: options.timeout, retries: 0, fetchImpl };
    // 每站一頁、依序執行，維持與監控相同的 HTTP 標頭和解析器。
    for (const store of options.stores) {
      const started = Date.now();
      try {
        const result = store === 'bb'
          ? await bestbuy.search({ query: 'rtx 5080', size: 1 }, httpOptions)
          : store === 'wt'
            ? await woot.search({ query: 'rtx 5080', limit: 1 }, httpOptions)
            : store === 'ne'
              ? await newegg.search({ query: 'rtx 5080' }, httpOptions)
              : await walmart.probe({ query: 'rtx 5080', sort: 'new', page: 1 }, httpOptions);
        checks.push({ name: store, status: result.items.length ? 'pass' : 'warn', code: result.items.length ? 'ok' : 'empty', durationMs: Date.now() - started, items: result.items.length, total: result.total,
          message: result.items.length ? '商品結構解析成功。' : '查詢結構有效，但沒有可解析的商品；尚不足以確認商品抓取可用。' });
      } catch (err) {
        const code = Object.hasOwn(ACTIONS, err.code) ? err.code : 'unexpected';
        checks.push({ name: store, status: 'fail', code, ...(Number.isInteger(err.status) && { httpStatus: err.status }), durationMs: Date.now() - started,
          message: ACTIONS[code] ?? '診斷發生未預期錯誤，請檢查程式與測試。' });
      }
    }
    if (options.cdpUrl) {
      try {
        const response = await fetchImpl(`${options.cdpUrl}/json/version`, { signal: AbortSignal.timeout(options.timeout) });
        const info = response.ok ? await response.json() : null;
        const debuggerUrl = new URL(info?.webSocketDebuggerUrl ?? 'invalid');
        if (!['ws:', 'wss:'].includes(debuggerUrl.protocol)) throw new Error();
        checks.push({ name: 'cdp', status: 'pass', code: 'ok', message: '既有 CDP 端點有回應；未建立 WebSocket 或控制分頁。' });
      } catch {
        checks.push({ name: 'cdp', status: 'fail', code: 'cdp_unavailable', message: 'CDP 端點無法取得有效的瀏覽器資訊；檢查瀏覽器是否已啟動。' });
      }
    }
  }
  return { schemaVersion: 1, checkedAt: new Date().toISOString(), mode: options.offline ? 'offline' : 'http', checks,
    exitCode: checks.some(c => c.status === 'fail') ? 1 : 0,
    boundary: '單次 HTTP／能力檢查；不代表 Chromium 容器、持續監控、庫存或通知已驗收。' };
}

export async function doctorCli(args) {
  let options;
  try { options = parseDoctorArgs(args); }
  catch (err) {
    const report = { schemaVersion: 1, code: 'usage', message: err.message, exitCode: 2 };
    if (args.includes('--json')) console.log(JSON.stringify(report)); else console.error(report.message);
    return 2;
  }
  if (options.help) {
    console.log('node dealwatch.mjs doctor [--offline] [--store bb|wm|wt|ne] [--json] [--timeout-ms 12000] [--cdp-url http://127.0.0.1:9222]\n每站查詢一頁；不讀 .env、不寫 data、不啟動瀏覽器、不發通知。退出碼：0 無失敗（可含警告）、1 診斷失敗、2 參數錯誤。');
    return 0;
  }
  const report = await createDoctorReport(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    for (const check of report.checks) console.log(`[${check.status}] ${check.name} (${check.code}) ${check.message}${check.durationMs == null ? '' : ` ${check.durationMs} ms`}`);
    console.log(report.boundary);
  }
  return report.exitCode;
}
