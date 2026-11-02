# 更新紀錄

版本號採用 [語意化版本](https://semver.org/lang/zh-TW/)：`主版本.次版本.修訂`。
- 修訂（1.1.**x**）：修 bug、小調整
- 次版本（1.**x**.0）：新增功能，舊用法不受影響
- 主版本（**x**.0.0）：不相容的大改

## [1.1.0] - 2026-11-02
### 新增
- 「從 Garmin 抓取」按鈕：透過 Cloudflare Worker 中繼站，直接從 Garmin Personal API 列出最近活動並下載原始 .fit 檔，下載後走原本的 FIT 解析流程。
- 活動清單可選最近 7 / 30 / 90 天；一鍵「載入最新的未匯入活動」。
- 記錄已匯入的 activityId，清單標示「已匯入／新」，可清除紀錄。
- 新的「Garmin」設定分頁：中繼站網址、存取密碼（眼睛圖示切換顯示）、測試連線。設定只存在本機瀏覽器。
- `worker/`：Cloudflare Worker 中繼站（`/health`、`/activities`、`/fit/{id}`），含 X-Key 驗證、CORS、token 快取（記憶體＋KV）、金鑰過期提示、每小時 Cron 預先抓活動清單。
- Worker 自動化測試（`cd worker && npm test`）。

### 調整
- 檔案載入流程抽成共用的 `loadActivityBuffer()`，本機檔案和 Garmin 下載共用同一條路。
- 手機版頂部按鈕列：活動名稱改到第二行，按鈕不再擠在一起。

## [1.0.0] - 2026-11-02
### 新增
- 從 Claude Artifact 搬到 GitHub，改成可獨立執行的 `index.html`，用 GitHub Pages 發佈。
