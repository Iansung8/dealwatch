# 部署前診斷

`doctor` 使用正式抓取模組的請求標頭和解析器，每家店查一頁、每個請求最多嘗試一次。它不讀 `config.mjs` 或 `.env`，不建立／修改 `data/`，不啟動網頁、瀏覽器或通知。診斷使用固定關鍵字 `rtx 5080`；Best Buy 不帶個人 ZIP，因此結果只驗證取價和解析，未驗證你的取貨地點。

## 本機

在程式根目錄執行，使用 Node.js 20 以上，無須 `npm install`：

```powershell
npm test
node dealwatch.mjs doctor --offline
node dealwatch.mjs doctor --json
node dealwatch.mjs doctor --store bb --timeout-ms 12000
```

`--offline` 不發送網路請求。一般模式依序查 Best Buy 與 Walmart；Walmart 的一頁可能包含多筆商品。`--timeout-ms` 控制單次請求的上限（100–30000 ms），底層連線也可能更早失敗。退出碼 0 代表沒有失敗，但可能含警告；1 代表診斷失敗；2 代表參數錯誤。`empty` 警告代表有效空結果，尚不足以確認商品抓取可用。

## 在 NAS 記憶體中執行

本機需要 Python 3、OpenSSH 與已受信任的 NAS host key；NAS 需要已啟用的 SSH、公鑰認證及既有 Node.js 20 以上。腳本使用非互動 `BatchMode=yes`，不會詢問 NAS 密碼或私鑰密語；加密私鑰須先載入 ssh-agent。SSH 認證失敗表示尚未執行診斷，不是商店連線失敗。以下指令將四個診斷模組包成記憶體模組，透過 SSH stdin 交給 NAS 的 Node.js；NAS 不落地任何程式、設定或報告，也不安裝套件或容器。

```powershell
py -3 tools/nas_preflight.py --host NAS的IP --user NAS帳號 --identity C:/Users/你的帳號/.ssh/id_ed25519
py -3 tools/nas_preflight.py --host NAS的IP --user NAS帳號 --identity C:/Users/你的帳號/.ssh/id_ed25519 --live
```

第一行預設離線；第二行才會對兩站各查一頁。可加 `--store bb` 或 `--store wm`。預設 Node 路徑是 `/usr/local/bin/node`，必要時用 `--node` 指定。程式維持 SSH host key 驗證；新主機需先由使用者確認指紋。報告輸出到本機終端機，可自行重導至本機檔案；報告不包含商品名稱、帳密或完整 CDP 網址。

## 判讀結果

| 代碼 | 意義與處理 |
| --- | --- |
| `ok` | 當次請求與商品解析成功，仍需後續實機驗收 |
| `browser_unavailable` | Node 缺少內建 WebSocket；直接 HTTP 可繼續，完整功能使用 Node.js 22 以上 |
| `dns` | 檢查 NAS DNS；若使用 Google DNS，位址為 8.8.8.8／8.8.4.4 |
| `tls` | 檢查時間、CA 憑證與 TLS 路徑，保留憑證驗證 |
| `timeout`／`network` | 檢查出口及網站回應，稍後低頻重測 |
| `blocked` | 網站拒絕或要求驗證；由使用者以瀏覽器確認並完成驗證 |
| `http` | 其他非成功 HTTP 狀態，報告會列狀態碼 |
| `format`／`upstream` | 回應結構或 GraphQL 查詢改變，需檢查抓取模組 |
| `empty` | 結構有效、無商品，屬警告 |

只有需要檢查「已經啟動的」CDP 端點時，才加 `--cdp-url http://127.0.0.1:9222`。它只讀 `/json/version`，不啟動瀏覽器、不連 WebSocket、不控制分頁；因此成功也不代表完整瀏覽器流程通過。它不能和 `--offline` 合用，也不會從 `.env` 讀取網址。

## 驗證邊界

curl 可協助確認 DNS、TCP 與 TLS，但請求標頭和執行環境與 Node.js 不同，curl 逾時或出現驗證頁並不等於本程式必定失敗。單次診斷也不能保證長期監控穩定。部署前應取得目標 NAS 的成功取價證據，容器啟動、持續監控、通知及重啟後資料保存依 [Synology 部署說明](../synology/README.md) 另行驗收。

來源（查詢日期 2026-10-08）：[Google DNS](https://developers.google.com/speed/public-dns/docs/using)、[curl 手冊](https://curl.se/docs/manpage.html)、[上游 HTTP 層](https://github.com/ayakasanma/dealwatch/blob/main/src/http.mjs)。
