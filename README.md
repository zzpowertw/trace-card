# 運動軌跡卡（Trace Card）

把 Garmin 活動做成可以分享到 IG 限動的運動卡片（PNG，支援透明背景）。

- 網頁本體：`index.html`（純前端單一檔案，用 GitHub Pages 發佈）
- Garmin 中繼站：`worker/`（Cloudflare Worker，免費方案即可）

活動檔有兩種來源：
1. **載入活動檔**：從 Garmin Connect 手動匯出的 `.fit` / `.zip`。
2. **從 Garmin 抓取**：透過中繼站直接從 Garmin Personal API 抓（需要先完成下方設定）。

---

## 一、網頁（GitHub Pages）

網址：https://zzpowertw.github.io/trace-card/

Repo 的 **Settings → Pages → Build and deployment** 選 `Deploy from a branch`、`main`、`/ (root)`。
之後在 GitHub 上直接改 `index.html`（鉛筆圖示 → Commit changes），1～2 分鐘後網址就會更新。

## 二、Garmin 中繼站（Cloudflare Worker）

### 為什麼需要中繼站
Garmin Personal API 不能從瀏覽器直接呼叫（CORS 會擋），而且 API 金鑰不能放在網頁裡。中繼站替網頁呼叫 Garmin，金鑰只存在 Cloudflare。

### 部署步驟（推薦：連動 GitHub，之後改 `worker/` 會自動重新部署）
1. 註冊／登入 [Cloudflare](https://dash.cloudflare.com/)。
2. **建立 KV**：左側 `Storage & Databases → Workers KV → Create`，名稱填 `trace-card-kv`，建立後複製它的 **ID**。
3. 在 GitHub 編輯 `worker/wrangler.toml`：把最下面三行的 `#` 拿掉，`id` 換成剛剛的 KV ID，Commit。
4. **建立 Worker**：`Workers & Pages → Create → Import a repository`，選這個 repo：
   - Project name：`trace-card-garmin`（要跟 `wrangler.toml` 的 `name` 一樣）
   - **Root directory：`worker`**
   - Build command 留空、Deploy command 用預設的 `npx wrangler deploy`
5. 部署完成後，到這個 Worker 的 **Settings → Variables and Secrets → Add**，類型選 **Secret**，加入兩個：

   | 名稱 | 內容 |
   |---|---|
   | `GARMIN_API_KEY` | Garmin Connect 網頁版建立的 Personal API 金鑰 |
   | `ACCESS_KEY` | 自己想一組長一點的密碼（網頁要填同一組） |

6. 記下 Worker 網址，例如 `https://trace-card-garmin.<你的帳號>.workers.dev`。
7. `worker/wrangler.toml` 的 `ALLOWED_ORIGINS` 已設成 `https://zzpowertw.github.io`，只有這個網頁能呼叫中繼站（要在本機測試時可暫時改成空字串）。

> 用指令部署也可以：`cd worker && npx wrangler deploy`，secret 用 `npx wrangler secret put GARMIN_API_KEY`、`npx wrangler secret put ACCESS_KEY` 設定。

### 測試
1. 瀏覽器開 `https://<Worker 網址>/health`，應該看到 `"hasApiKey":true,"hasAccessKey":true,"hasKV":true`。
2. 打開網頁 → **Garmin** 分頁 → 填中繼站網址和存取密碼 → 按 **測試連線**，出現「連線成功」。
3. 按頂部 **從 Garmin 抓取** → 點一筆活動，卡片就會換成那筆活動。

### Garmin 金鑰到期時
金鑰效期是 30 / 90 / 180 天或 1 年。到期後網頁會顯示「Garmin API 金鑰無效或已過期…」，
請到 Garmin Connect 重新建立金鑰，再到 Cloudflare 更新 `GARMIN_API_KEY` 這個 Secret（不用改程式）。

### 中繼站 API
| 路徑 | 說明 |
|---|---|
| `GET /health` | 檢查設定是否齊全（不需密碼） |
| `GET /activities?days=30` | 最近活動精簡清單；`&fresh=1` 略過快取直接問 Garmin |
| `GET /fit/{activityId}` | 該活動的原始 `.fit` bytes |

除了 `/health`，每個請求都要帶 `X-Key: <ACCESS_KEY>`。

### 安全
- 金鑰、密碼**絕對不要**寫進程式碼或 commit；只放在 Cloudflare Secret 和自己的瀏覽器裡。
- 網頁的中繼站網址、密碼、已匯入紀錄都存在該裝置瀏覽器的 localStorage。

---

## 開發
- Worker 測試：`cd worker && npm test`（用假的 Garmin 伺服器測試，不會真的連線）
- 每次改動請更新 `VERSION`、`index.html` 裡的 `APP_VERSION`、`worker/src/index.js` 的 `VERSION`，並寫進 `CHANGELOG.md`。
