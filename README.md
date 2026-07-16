# TripTrace Research

一個只做 travel-video research 的獨立 Next.js 網站。輸入地點後，網站會用 `yt-dlp` 搜尋多部 YouTube 旅遊影片、讀取 timed captions、擷取 storyboard frame，再用 OpenAI 做保守的語意摘要。

本專案只有 research 首頁與 `/api/research-place` API；不包含 itinerary、trip、地圖或原專案首頁，也不會導向其他 TripTrace 頁面。

## 功能與資料對齊

- 搜尋至少多部不同 YouTube 影片；正式結果要求至少 4 個不同影片來源。
- 只讀 metadata、字幕與 storyboard，不下載或重新發布影片串流。
- 下載並解析 timed JSON3 captions，所有 `startSeconds` 都由字幕 cue 計算。
- 由 storyboard sprite 擷取最接近 timestamp 的 frame，沒有 frame 時退回 YouTube thumbnail。
- OpenAI 只負責在已鎖定的 clip 上做語意分類與摘要，不得修改 video ID、timestamp 或 transcript。
- 每個結果都顯示：`Why it’s worth going`、`What to do`、`What to eat`、`Good to know`。
- title 必須引用 exact transcript 的具體主題；key takeaway 必須與 transcript 有足夠詞彙重疊；transcript、timestamp、YouTube 連結指向同一個 clip。
- 當地點只是字幕順帶提到、來源其實是其他街區／景點，或語意分類不可靠時，clip 會被排除。
- 沒有 OpenAI key 時仍有 deterministic extractive fallback，但不會產生像 `Food evidence from this clip` 這類 generic title。

## 安裝

需求：Node.js 20+、npm，以及可執行的 `yt-dlp`。

```bash
npm install
```

## yt-dlp

新地點研究必須使用目前版本的 `yt-dlp`，並且能從 shell 執行：

```bash
yt-dlp --version
```

如果 `yt-dlp` 不在 PATH，可在 `.env.local` 設定：

```text
YT_DLP_BIN=/absolute/path/to/yt-dlp
```

網站會使用 `yt-dlp` 的 YouTube search、video metadata、timed captions 與 storyboard format；不會使用 `-f` 下載 video/audio。

## `.env.local`

先複製範例檔：

```bash
cp .env.example .env.local
```

只在本機 `.env.local` 的空白 `OPENAI_API_KEY` 後填入真正的 key：

```text
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
YT_DLP_BIN=
TRIPTRACE_CACHE_DIR=
```

`OPENAI_API_KEY` 只從 server-side 的 `process.env.OPENAI_API_KEY` 讀取；程式碼、client bundle、`.env.example` 與 Git 都不應包含 key。`.env.local` 已列入 `.gitignore`。沒有 key 時會使用 deterministic fallback，仍需要 `yt-dlp` 才能抓取新來源。

不使用資料庫。預設 cache 在作業系統的本機 temporary directory 下 `triptrace-research`；可用 `TRIPTRACE_CACHE_DIR` 改成專案內的 `.cache/triptrace-research` 或另一個本機目錄。cache 內容包含短期的研究結果、字幕 JSON3 與 semantic analysis，不會進 Git。

## Local 啟動

```bash
npm run dev -- -p 3100
```

開啟 [http://localhost:3100](http://localhost:3100)。表單預設為：

- Place: `Taipei 101`
- City: `Taipei`
- 快速提示地點：`Ximending`、`Dadaocheng`、`Shilin Night Market`

第一次研究會依 YouTube 回應速度花費數十秒；相同地點在 cache 有效期間會直接載入。若要重新抓取，勾選 `Ignore saved result and research again`。

## 測試與驗證

```bash
npm test
npm run typecheck
npm run build
```

測試涵蓋：

- JSON3 timed cue parsing 與 timestamp 不造假；
- 四個 research 分類、至少三個不同影片來源與 distinct clips；
- generic title 防護與 extractive fallback；
- Taipei 101 這類 numeric landmark 的精確地點 gate；
- 其他街區、順帶提及、錯誤分類與未對齊的 AI 摘要排除；
- place/city 輸入安全驗證。

## 本機 GitHub 狀態

這個目錄可作為獨立 local Git repository；目前不會自動建立 GitHub remote、不會部署，也不會 push。預設建議的遠端 repository 名稱是 `triptrace-research`。建立遠端前請先確認 repository 名稱與 visibility。
