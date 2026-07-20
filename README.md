# TripTrace Research

**Turn real travel videos into a trustworthy, timestamped guide for one place.**

TripTrace Research is an OpenAI Build Week project in the **Apps for Your Life** category. It helps travelers use the valuable details hidden inside long YouTube videos without trusting an untraceable AI summary.

Enter a place and TripTrace returns four practical views:

- Why it’s worth going
- What to do
- What to eat
- Good to know before you go

Every recommendation keeps its receipt: a specific title, concise takeaway, exact transcript, timestamp, video frame, location status, and a YouTube link that opens at the supporting moment.

## The problem

Travel videos contain first-hand observations that often do not appear in generic travel pages, but the useful evidence is scattered across many long videos. Conventional summaries introduce a second problem: users cannot tell which creator said a claim, when they said it, or whether a restaurant mentioned in the same video is actually near the requested place.

TripTrace treats this as an evidence-verification problem, not just a summarization problem.

## What makes TripTrace different

- Local snapshot generation searches a broader, bounded pool of independent videos, keeps only videos published within the last two years, and expands a category when it still lacks two qualifying sources.
- Timestamps come from timed YouTube captions; the model cannot invent them.
- Titles and takeaways must remain aligned with an exact transcript excerpt.
- Generic titles such as “Food evidence from this clip” are rejected.
- GPT-5.6 classifies whether a place is the main subject, merely mentioned, inside the requested place, nearby, or in a different area.
- Separately named places are checked against OpenStreetMap coordinates and a conservative distance radius.
- Verified partial results appear immediately while missing categories continue researching. If one evidence or API step is unavailable, exact transcript matches that already exist are still shown and the missing category is explained instead of being filled with a generic claim.
- Ambiguous, unsupported, unresolved, or distant recommendations are omitted instead of guessed.

## Why snapshots are intentional

TripTrace is useful only when every recommendation can lead back to the original video, its timed transcript, and the exact YouTube moment that supports it. Some datacenter IP ranges are asked by YouTube to complete bot verification, which means a public server cannot always collect new caption evidence reliably.

The public demo therefore uses a **verified snapshot + seven-day cache-first** design. A snapshot is saved research with an inspectable source chain—video, creator, publication date, exact transcript, timestamp, frame or thumbnail, and location check—not AI-invented travel content. If there is no saved verified result, TripTrace says that source material is unavailable instead of producing a generic claim.

To avoid a one-creator claim becoming a place recommendation, a public snapshot needs **two different qualifying videos for each of the four categories**. That means at least eight evidence cards, alongside the existing recency, transcript, timestamp, location, and source-diversity checks. A place that falls short remains a visible local draft rather than being published as “verified.”

TripTrace does not bypass platform protections, pass through user cookies, or download YouTube video or audio. The official YouTube Data API can help with search and metadata, but it cannot download captions for arbitrary third-party videos. The long-term path is creator-authorized captions or other licensed sources. This is a visible product and platform trade-off, not a hidden error.

## Verification funnel

The product exposes its real pipeline counts so users and judges can see how a result was produced:

```text
Video candidates
      ↓
Captioned sources
      ↓
Candidate transcript clips
      ↓
Evidence matches
      ↓
Location-verified recommendations
```

The UI also reports how many extracted clips were excluded by evidence/ranking checks and how many failed location or distance verification. These numbers come from the server pipeline; they are not decorative frontend animation.

## Model and cost controls

The public Cloud Run service does not run new YouTube research. Local snapshot generation starts with the lower-cost **`gpt-5.4-nano`** model for source exploration, then sends only deterministic survivors to **`gpt-5.6-luna`** for final semantic verification. `TRIPTRACE_TEST_MODE=fixture` can run the legacy Taipei 101 regression fixture without calling OpenAI or yt-dlp. `TRIPTRACE_RUNTIME=production` is a hard safety boundary: cache misses return source-unavailable rather than trying live research.

The model receives only fixed evidence fields:

- requested place and city
- video title
- exact timed transcript
- nearby transcript context
- candidate visitor-intent category

GPT-5.6 returns a typed analysis containing the primary subject, supported title, takeaway, verbatim support quote, category, location relationship, POI name, location evidence, and confidence. Deterministic code then rejects outputs that fail quote alignment, title specificity, landmark matching, actionable-tip rules, or location verification.

The model summarizes and classifies evidence; it does not choose or rewrite timestamps.

## How Codex accelerated the build

Codex was used as the engineering environment for the project, not as a feature label added after implementation. It helped:

- inspect and preserve the existing standalone Next.js architecture;
- design the typed research and streamed partial-result contracts;
- implement YouTube caption extraction, semantic guardrails, local caching, and geospatial verification;
- identify failure modes such as incidental location mentions, numeric-landmark false positives, distant POIs, transient geocoder failures, and cache/model mixing;
- add deterministic regression tests before changing model behavior;
- perform code-review passes focused on correctness, security, privacy, and accidental scope expansion;
- run desktop and mobile browser QA against the local application.

Key product decisions made during the Codex sessions include keeping API keys server-side, avoiding a database, never downloading video streams, preferring partial verified results over all-or-nothing failure, and rejecting uncertain recommendations rather than filling category gaps with generic content.

## How it works

1. **Resolve public requests** — Serve a validated verified snapshot first, then a still-valid seven-day cache.
2. **State limits honestly** — If neither exists, return source-unavailable; Cloud Run never starts `yt-dlp` on a miss.
3. **Generate locally when authorised** — The local-only generator searches recent video metadata and timed captions one place at a time.
4. **Screen and match** — Videos, transcript clips, titles, location relationships, and distance evidence are checked deterministically.
5. **Verify final candidates** — A development model explores cheaply; the production-quality model sees only shortlisted evidence.
6. **Publish only complete evidence** — A snapshot needs two different recent videos for each of the four categories (at least eight cards), four different videos overall, matching timestamps, and completed location checks before it can enter the public registry.
7. **Show the receipt** — Every displayed result links back to the exact YouTube timestamp.

No database is required. Captions, semantic analysis, geocoding responses, and final research are stored in a local seven-day cache. The cache key includes the OpenAI model so evidence produced by different models is never silently mixed. Public snapshot/cache replays do not call OpenAI or `yt-dlp`.

## Default demo and sample data

The page defaults to `Taipei 101, Taipei`, replays its public verified snapshot for about four seconds, and then moves to the source-backed result. Only JSON files that pass the registry validator can appear there. The older Taipei 101 sample remains a **legacy local fixture** for regression testing because it contains 2023 and 2018 sources; it is deliberately not in the public registry.

Use the quick suggestions for `Ximending`, `Dadaocheng`, and `Shilin Night Market`. A public request will replay a matching snapshot or cache for about four seconds. When a source caption is Chinese, the public card is presented in English while preserving the same video, timestamp, and evidence linkage. It does not start live discovery on Cloud Run.

## Run locally

### Requirements

- Node.js 20+
- npm
- a current `yt-dlp` executable (only for local snapshot generation)
- a server-side OpenAI key with access to the configured local development and final verification models

Install dependencies:

```bash
npm install
```

Confirm `yt-dlp` is available:

```bash
yt-dlp --version
```

Create the local environment file:

```bash
cp .env.example .env.local
```

Configure values only in `.env.local`:

```text
OPENAI_API_KEY=
OPENAI_DEV_MODEL=gpt-5.4-nano
TRIPTRACE_RUNTIME=development
TRIPTRACE_TEST_MODE=
YT_DLP_BIN=
TRIPTRACE_CACHE_DIR=
```

Start the site:

```bash
npm run dev -- -p 3100
```

Open [http://localhost:3100](http://localhost:3100).

Generate snapshots locally, one place at a time:

```bash
npm run snapshots:generate
```

The command processes Taipei 101, Ximending, Dadaocheng, and Shilin Night Market in that order. It performs a bounded first pass plus at most one category-targeted refill pass, always serially. It stops a place immediately on a YouTube bot-verification response, never retries around the protection, and reports each category as `n/2` different-video sources. Only complete snapshots—two qualifying videos in every category—are written to `data/snapshots/verified/` and the public registry; incomplete work remains under `data/snapshots/drafts/`.

If a just-generated draft already passes those deterministic source checks but an interrupted final semantic pass needs to be resumed, run:

```bash
npm run snapshots:finalize-drafts
```

This local-only command never calls yt-dlp, never reads the public runtime cache, and accepts only drafts generated in the previous 24 hours. It runs the final production-quality semantic and location verification before a snapshot can enter the public registry.

To keep an already useful local partial result and search only its missing categories, run:

```bash
npm run snapshots:continue
```

It excludes every video already used by the draft, retains its verified partial clips, and performs serial local discovery only for the category gaps before re-running final verification.

If `yt-dlp` is outside `PATH`, set `YT_DLP_BIN` to its absolute path. `TRIPTRACE_CACHE_DIR` is optional; by default the cache uses the operating system’s temporary directory.

### Persistent seven-day cache in production

For a deployment that must keep research across restarts, attach a persistent volume and point `TRIPTRACE_CACHE_DIR` at its mounted directory, for example:

```text
TRIPTRACE_CACHE_DIR=/data/triptrace-cache
```

The application expires final research after seven days. Caption, semantic-analysis, geocoding, and result files remain on the mounted volume between deploys. A verified snapshot or cache hit replays the five research stages for about four seconds before showing the saved result, leaving cold-start, network, and rendering headroom to stay under five seconds. This replay creates no OpenAI or `yt-dlp` usage.

An ephemeral or free-instance filesystem cannot guarantee cache survival after a restart. Versioned verified snapshots remain available with the application build; runtime-cache persistence requires the provider’s persistent-disk option. The legacy Taipei 101 fixture is not a public fallback.

### Google Cloud deployment

The repository includes a production `Dockerfile` for Cloud Run. The runtime image intentionally does **not** install `yt-dlp`; it runs Next.js on port `8080`, excludes `.env` files from the build context, and resolves only snapshots or saved cache. The recommended deployment uses:

- Cloud Run in `asia-east1` with request-based billing and scale-to-zero;
- Secret Manager for `OPENAI_API_KEY`;
- a Cloud Storage volume mounted at `/cache`;
- `TRIPTRACE_CACHE_DIR=/cache/triptrace-research`;
- the lifecycle policy in `deploy/gcs-lifecycle.json` to remove cache objects after eight days, allowing the application’s seven-day TTL to complete safely.

## Security and data boundaries

- `OPENAI_API_KEY` is read only from `.env.local` by server-side code.
- `.env.local` is ignored by Git and must never be copied into code, documentation, or client output.
- User input is schema-validated and cannot contain URLs or shell expressions.
- Public research requests are rate-limited.
- Nominatim calls use a project User-Agent, global one-request-per-second scheduling, attribution, and local caching.
- The system downloads captions, metadata, and storyboard images only—never YouTube video or audio streams.
- There is no database, account system, itinerary page, or connection to the original TripTrace project.

## Project structure

```text
app/          Next.js page, styles, and streamed research API
components/   Research form, progress, funnel, and evidence cards
data/         Versioned verified-snapshot registry, drafts, and legacy fixture data
lib/          YouTube, transcript, GPT-5.6, cache, and geospatial pipeline
public/       Bundled demo storyboard frames
scripts/      Snapshot export utility
types/        Shared typed research and stream contracts
tests/        Evidence, location, funnel-adjacent, and stream regressions
```

## Verification commands

```bash
npm test
npm run typecheck
npm run build
```

The automated suite covers timed-caption parsing, source diversity, the two-videos-per-category snapshot threshold, title specificity, evidence alignment, incidental-place rejection, numeric landmarks, different-area recommendations, distance calculations, location radii, request validation, demo-snapshot integrity, and preservation of partial results when later research fails.

## Known limitations

- Caption availability and accuracy depend on YouTube and the original creator.
- New live research intentionally excludes videos without a verifiable publication date or older than two years; a smaller result is preferable to silently using stale evidence.
- Public Cloud Run requests do not perform fresh research when a snapshot/cache is absent; local generation needs a permitted public source response and may produce a draft instead of a snapshot.
- The local research pipeline prefers English timed captions when available, then uses public Traditional/Simplified Chinese timed captions with the same quote, timestamp, and location checks.
- OpenStreetMap coverage varies; ambiguous POIs are excluded.
- Storyboards are not available for every video, so the UI may use the YouTube thumbnail.
- Opening hours, prices, reservations, closures, and local rules still require a current check.
- The legacy Taipei 101 sample is deliberately excluded from the public registry because its older sources fail the current recency rule.

## License

This project is available under the [MIT License](LICENSE).

---

# 繁體中文

**把真實旅遊影片轉化為一個地點可信、可回溯時間戳的指南。**

TripTrace Research 是 OpenAI Build Week「**Apps for Your Life**」類別的專案。它協助旅客使用長篇 YouTube 旅遊影片中真正有價值的細節，而不必相信無法追溯來源的 AI 摘要。

輸入一個地點後，TripTrace 會整理出四個實用面向：

- 為什麼值得去
- 可以做什麼
- 可以吃什麼
- 出發前要知道什麼

每一項建議都保留可檢查的依據：明確標題、簡短重點、逐字字幕、時間戳、影片畫面、地點驗證狀態，以及可直接開啟到佐證時刻的 YouTube 連結。

## 問題

旅遊影片包含許多一般旅遊網站沒有的第一手觀察，但有用的證據分散在許多支很長的影片中。一般摘要還會造成第二個問題：使用者無法知道哪位創作者提出這個說法、是在什麼時間點說的，或同一支影片裡提到的餐廳是否真的靠近查詢的地點。

TripTrace 將這件事視為「證據驗證」問題，而不只是摘要問題。

## TripTrace 有什麼不同

- 本機 snapshot 產生器會在有限但較廣的獨立影片來源中搜尋，只保留兩年內發布的影片；若某分類仍少於兩個合格來源，才會針對該分類補找。
- 時間戳來自帶時間資訊的 YouTube 字幕，模型不能自行編造。
- 標題與重點必須和逐字字幕片段一致。
- 像「這支片段的美食證據」這類過於籠統的標題會被拒絕。
- GPT-5.6 會判斷某地點是影片主題、僅被順帶提到、位於查詢地點內、在附近，或其實屬於不同區域。
- 系統會以 OpenStreetMap 座標與保守的距離半徑檢查個別命名地點。
- 已驗證的部分結果會立即顯示，同時繼續研究尚缺的分類。若其中一個證據或 API 步驟無法使用，已存在的精確字幕比對仍會保留，缺少的分類會如實說明，而不會以籠統說法填補。
- 模糊、缺乏支持、無法判定或距離過遠的建議會被排除，不會猜測補上。

## 為什麼刻意使用 snapshots

TripTrace 的價值只在於每個建議都能回到原始影片、帶時間資訊的逐字字幕，以及支撐該建議的確切 YouTube 時刻。部分資料中心 IP 範圍會被 YouTube 要求完成 bot verification，因此公開伺服器不一定能可靠地蒐集新的字幕證據。

因此公開 demo 採用 **已驗證 snapshot + 七天 cache 優先** 的設計。snapshot 是已保存且可檢查來源鏈的研究成果，包含影片、創作者、發布日期、逐字字幕、時間戳、畫面或縮圖，以及位置檢查；它不是 AI 編造的旅遊內容。若沒有已保存的驗證結果，TripTrace 會清楚表示目前無法取得來源資料，而不是產生籠統的建議。

為避免一位創作者的單一說法變成整個地點的推薦，公開 snapshot 的四個分類都必須各有 **兩支不同的合格影片**。這代表至少八張證據卡，並同時通過既有的時效、字幕、時間戳、位置與來源多樣性檢查。未達標的地點只會保留為可見的本機草稿，不會被發布為「已驗證」。

TripTrace 不會繞過平台保護、不會傳遞使用者 cookies，也不會下載 YouTube 影片或音訊。官方 YouTube Data API 可以協助搜尋與讀取 metadata，但無法下載任意第三方影片的字幕。長期方向是取得創作者授權的字幕或其他授權資料來源。這是明確揭露的產品與平台取捨，不是被隱藏的錯誤。

## 驗證漏斗

產品會呈現實際的 pipeline 數字，讓使用者與評審能看見結果如何產生：

```text
影片候選
      ↓
有字幕的來源
      ↓
候選字幕片段
      ↓
通過證據比對
      ↓
通過位置驗證的建議
```

UI 也會顯示有多少萃取片段因證據或排序檢查而被排除，以及多少項目未通過位置或距離驗證。這些數字來自伺服器 pipeline，不是裝飾性的前端動畫。

## 模型與成本控管

公開 Cloud Run 服務不會執行新的 YouTube 研究。本機 snapshot 產生會先用成本較低的 **`gpt-5.4-nano`** 做來源探索，然後只將通過確定性篩選的候選資料送到 **`gpt-5.6-luna`** 做最終語意驗證。設定 `TRIPTRACE_TEST_MODE=fixture` 時，可執行舊版 Taipei 101 的回歸測試 fixture，不會呼叫 OpenAI 或 yt-dlp。`TRIPTRACE_RUNTIME=production` 是硬性安全邊界：cache miss 會回傳 source-unavailable，而不會嘗試即時研究。

模型只會收到固定的證據欄位：

- 查詢的地點與城市
- 影片標題
- 帶時間資訊的逐字字幕
- 附近的字幕上下文
- 候選的旅客意圖分類

GPT-5.6 會回傳帶型別的分析，內容包含主要主題、可支持的標題、重點、逐字支持引文、分類、地點關係、POI 名稱、位置證據與信心程度。接著確定性程式碼會拒絕未通過引文一致性、標題具體性、地標比對、可行動建議規則或位置驗證的結果。

模型負責摘要與分類證據；它不會選擇或改寫時間戳。

## Codex 如何加速開發

Codex 是本專案的工程開發環境，而不是實作完成後才加上的功能標籤。它協助：

- 檢查並保留既有的 standalone Next.js 架構；
- 設計有型別的研究資料與串流 partial-result 合約；
- 實作 YouTube 字幕擷取、語意防護、local cache 與地理位置驗證；
- 找出順帶提及地點、數字地標誤判、遙遠 POI、暫時性地理編碼失敗，以及 cache／模型混用等失敗情況；
- 在改變模型行為前先加入確定性的回歸測試；
- 以正確性、安全性、隱私與避免意外擴大範圍為重點進行 code review；
- 對本機應用程式進行桌面與手機瀏覽器 QA。

在 Codex 工作過程中作出的重要產品決策包括：將 API key 保留在伺服器端、不使用資料庫、絕不下載影片串流、優先呈現部分已驗證結果而不是全有或全無地失敗，以及拒絕不確定的推薦而不以籠統內容填滿分類空缺。

## 運作方式

1. **處理公開請求** — 先提供通過驗證的 snapshot，接著才使用仍在七天有效期內的 cache。
2. **誠實呈現限制** — 若兩者都沒有，回傳 source-unavailable；Cloud Run 絕不會在 miss 時啟動 `yt-dlp`。
3. **僅在本機授權產生** — local-only generator 會逐一搜尋近期影片 metadata 與帶時間資訊的字幕。
4. **篩選與比對** — 以確定性規則檢查影片、字幕片段、標題、地點關係與距離證據。
5. **驗證最終候選** — 開發模型以較低成本探索；production-quality 模型只會看到入選的證據。
6. **只發布完整證據** — snapshot 必須讓四個分類各有兩支不同的近期影片（至少八張卡）、整體至少四支不同影片、時間戳相符且位置檢查完成，才可進入公開 registry。
7. **展示依據** — 每個顯示的結果都能連回確切的 YouTube 時間戳。

不需要資料庫。字幕、語意分析、地理編碼回應與最終研究結果會儲存在本機七天 cache。cache key 會包含 OpenAI model，因此不同模型產生的證據不會被悄悄混用。公開 snapshot/cache 回放不會呼叫 OpenAI 或 `yt-dlp`。

## 預設 demo 與範例資料

頁面預設為 `Taipei 101, Taipei`，會回放其公開已驗證 snapshot 約四秒，接著移動到有來源支持的結果。只有通過 registry validator 的 JSON 檔案能出現在這裡。較舊的 Taipei 101 範例因包含 2023 與 2018 年來源，僅保留為回歸測試用的 **legacy local fixture**，刻意不納入公開 registry。

可使用 `Ximending`、`Dadaocheng` 與 `Shilin Night Market` 的快速建議。公開請求會回放對應的 snapshot 或 cache 約四秒。當來源字幕是中文時，公開卡片會以英文呈現，同時保留相同的影片、時間戳與證據連結。Cloud Run 不會啟動即時探索。

## 在本機執行

### 需求

- Node.js 20+
- npm
- 目前可用的 `yt-dlp` 執行檔（僅供本機 snapshot 產生）
- 可存取設定之本機開發與最終驗證模型的 server-side OpenAI key

安裝相依套件：

```bash
npm install
```

確認 `yt-dlp` 可用：

```bash
yt-dlp --version
```

建立本機環境檔：

```bash
cp .env.example .env.local
```

僅在 `.env.local` 設定以下值：

```text
OPENAI_API_KEY=
OPENAI_DEV_MODEL=gpt-5.4-nano
TRIPTRACE_RUNTIME=development
TRIPTRACE_TEST_MODE=
YT_DLP_BIN=
TRIPTRACE_CACHE_DIR=
```

啟動網站：

```bash
npm run dev -- -p 3100
```

開啟 [http://localhost:3100](http://localhost:3100)。

在本機逐一產生 snapshots：

```bash
npm run snapshots:generate
```

此指令會依 Taipei 101、Ximending、Dadaocheng、Shilin Night Market 的順序處理。它會執行有界限的第一次搜尋，並且最多只進行一次分類導向的補找，始終以串行方式執行。偵測到 YouTube bot-verification 回應時，該地點會立刻停止；系統不會嘗試繞過保護，並會以每個分類 `n/2` 個不同影片來源的方式回報。只有完整 snapshots——四個分類都各有兩支合格影片——會寫入 `data/snapshots/verified/` 與公開 registry；未完成資料會保留在 `data/snapshots/drafts/`。

如果剛產生的草稿已通過這些確定性來源檢查，但中斷的最終語意處理需要繼續，可執行：

```bash
npm run snapshots:finalize-drafts
```

這個 local-only 指令絕不會呼叫 yt-dlp、不會讀取公開 runtime cache，且只接受前 24 小時內產生的草稿。snapshot 進入公開 registry 前，它會執行最終 production-quality 語意與位置驗證。

若要保留已有價值的本機 partial result，並且只搜尋缺少的分類，可執行：

```bash
npm run snapshots:continue
```

它會排除草稿已使用的所有影片，保留已驗證的部分片段，並且只對分類缺口依序執行本機探索，之後重新做最終驗證。

若 `yt-dlp` 不在 `PATH` 中，請將 `YT_DLP_BIN` 設為其絕對路徑。`TRIPTRACE_CACHE_DIR` 為可選設定；預設會使用作業系統的暫存目錄。

### Production 的持久化七天 cache

若部署必須在重新啟動後仍保留研究結果，請掛載持久化 volume，並將 `TRIPTRACE_CACHE_DIR` 指向掛載目錄，例如：

```text
TRIPTRACE_CACHE_DIR=/data/triptrace-cache
```

應用程式會在七天後讓最終研究結果失效。字幕、語意分析、地理編碼與結果檔案會在部署之間保留於掛載 volume。已驗證 snapshot 或 cache hit 會在顯示保存結果前，回放五個研究階段約四秒，以保留 cold start、網路與 rendering 的緩衝並維持在五秒內。此回放不會使用 OpenAI 或 `yt-dlp`。

短暫或免費方案的檔案系統無法保證重新啟動後仍保有 cache。版本化的 verified snapshots 會隨應用程式 build 一起提供；runtime cache 是否能持久保存，取決於服務商提供的 persistent disk 選項。legacy Taipei 101 fixture 不是公開 fallback。

### Google Cloud 部署

Repository 包含適用於 Cloud Run 的 production `Dockerfile`。runtime image 刻意不安裝 `yt-dlp`；它會在 port `8080` 執行 Next.js、從 build context 排除 `.env` 檔案，且只解析 snapshots 或已保存 cache。建議的部署設定為：

- 使用 `asia-east1` 的 Cloud Run，採 request-based billing 並可 scale-to-zero；
- 以 Secret Manager 保存 `OPENAI_API_KEY`；
- 將 Cloud Storage volume 掛載在 `/cache`；
- 設定 `TRIPTRACE_CACHE_DIR=/cache/triptrace-research`；
- 使用 `deploy/gcs-lifecycle.json` 的 lifecycle policy，在八天後移除 cache 物件，讓應用程式的七天 TTL 可安全完成。

## 安全性與資料界線

- `OPENAI_API_KEY` 僅由 server-side code 從 `.env.local` 讀取。
- `.env.local` 已被 Git 忽略，絕不可複製到程式碼、文件或 client output。
- 使用者輸入會經 schema 驗證，且不能包含 URL 或 shell expression。
- 公開研究請求會受到 rate limit 限制。
- Nominatim 呼叫會使用專案 User-Agent、全域每秒一個請求的排程、attribution 與 local cache。
- 系統只下載字幕、metadata 與 storyboard images，絕不下載 YouTube 影片或音訊串流。
- 沒有資料庫、帳號系統、itinerary page，也不會連到原始 TripTrace 專案。

## 專案結構

```text
app/          Next.js page、styles 與 streamed research API
components/   Research form、progress、funnel 與 evidence cards
data/         版本化 verified-snapshot registry、drafts 與 legacy fixture data
lib/          YouTube、transcript、GPT-5.6、cache 與 geospatial pipeline
public/       內建 demo storyboard frames
scripts/      Snapshot export utility
types/        共用的 typed research 與 stream contracts
tests/        Evidence、location、funnel-adjacent 與 stream regressions
```

## 驗證指令

```bash
npm test
npm run typecheck
npm run build
```

自動化測試涵蓋帶時間字幕解析、來源多樣性、每分類兩支影片的 snapshot 門檻、標題具體性、證據一致性、排除順帶提到的地點、數字地標、不同區域的建議、距離計算、位置半徑、請求驗證、demo-snapshot 完整性，以及後續研究失敗時仍保留部分結果。

## 已知限制

- 字幕能否取得及其正確性取決於 YouTube 與原始創作者。
- 新的即時研究會刻意排除沒有可驗證發布日期或超過兩年的影片；寧可結果較少，也不會悄悄使用過時證據。
- 當沒有 snapshot/cache 時，公開 Cloud Run 請求不會做新的研究；本機產生需要允許的公開來源回應，可能產生草稿而不是 snapshot。
- 本機研究 pipeline 優先使用英文帶時間字幕；若沒有英文字幕，會使用公開的繁體／簡體中文帶時間字幕，同樣通過引文、時間戳與位置檢查，並在公開卡片中以英文呈現。
- OpenStreetMap 覆蓋度不一；模糊的 POI 會被排除。
- 並非每支影片都有 storyboard，因此 UI 有時會改用 YouTube thumbnail。
- 營業時間、價格、訂位、暫停營業與當地規則仍需另外做最新查核。
- legacy Taipei 101 範例因較舊來源不符合目前時效規則，刻意不納入公開 registry。

## 授權

本專案採用 [MIT License](LICENSE)。
