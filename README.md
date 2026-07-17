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

- It searches several independent videos instead of summarizing one source.
- Timestamps come from timed YouTube captions; the model cannot invent them.
- Titles and takeaways must remain aligned with an exact transcript excerpt.
- Generic titles such as “Food evidence from this clip” are rejected.
- GPT-5.6 classifies whether a place is the main subject, merely mentioned, inside the requested place, nearby, or in a different area.
- Separately named places are checked against OpenStreetMap coordinates and a conservative distance radius.
- Verified partial results appear immediately while missing categories continue researching.
- Ambiguous, unsupported, unresolved, or distant recommendations are omitted instead of guessed.

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

## Built with GPT-5.6

Live research uses **`gpt-5.6-luna`** through the OpenAI Responses API with structured output. The model receives only fixed evidence fields:

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

1. **Search** — `yt-dlp` searches YouTube using several travel intents.
2. **Screen** — Videos are checked for captions, duration, embed access, and source diversity.
3. **Read evidence** — Timed JSON3 captions are parsed into transcript cues.
4. **Match clips** — Candidate moments are scored by place relevance and visitor intent.
5. **Verify with GPT-5.6** — Structured analysis identifies the main subject and transcript-supported claim.
6. **Apply deterministic guardrails** — Unsupported wording, generic titles, incidental mentions, and wrong categories are removed.
7. **Check distance** — Named nearby POIs are geocoded, cached, and compared with the requested place.
8. **Stream results** — Verified categories appear while the system continues researching missing ones.
9. **Show the receipt** — Every result links back to the exact YouTube timestamp.

No database is required. Captions, semantic analysis, geocoding responses, and final research are stored in a local seven-day cache. The cache key includes the OpenAI model so evidence produced by different models is never silently mixed.

## Default demo and sample data

The site opens with a bundled **Taipei 101 verified demo snapshot**, so judges can inspect the complete product immediately without waiting for a cold research run.

- Place: `Taipei 101`
- City: `Taipei`
- Four independently sourced, timestamped result cards
- Transcript and location verification metadata
- Three storyboard frames and one conservative YouTube-thumbnail fallback
- Quick suggestions: `Ximending`, `Dadaocheng`, `Shilin Night Market`

Select **Research live** to run fresh source discovery with GPT-5.6 Luna. A fresh run usually takes 30–90 seconds; verified partial results can appear before every category is complete.

## Run locally

### Requirements

- Node.js 20+
- npm
- a current `yt-dlp` executable
- an OpenAI API key with access to `gpt-5.6-luna`

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
OPENAI_MODEL=gpt-5.6-luna
YT_DLP_BIN=
TRIPTRACE_CACHE_DIR=
```

Start the site:

```bash
npm run dev -- -p 3100
```

Open [http://localhost:3100](http://localhost:3100).

If `yt-dlp` is outside `PATH`, set `YT_DLP_BIN` to its absolute path. `TRIPTRACE_CACHE_DIR` is optional; by default the cache uses the operating system’s temporary directory.

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
data/         Bundled Taipei 101 demo snapshot
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

The automated suite covers timed-caption parsing, source diversity, all four visitor categories, title specificity, evidence alignment, incidental-place rejection, numeric landmarks, different-area recommendations, distance calculations, location radii, request validation, demo-snapshot integrity, and preservation of partial results when later research fails.

## Known limitations

- Caption availability and accuracy depend on YouTube and the original creator.
- The current research pipeline prioritizes English caption tracks.
- OpenStreetMap coverage varies; ambiguous POIs are excluded.
- Storyboards are not available for every video, so the UI may use the YouTube thumbnail.
- Opening hours, prices, reservations, closures, and local rules still require a current check.
- The bundled snapshot is sample evidence; live research is the GPT-5.6 path and can discover different current sources.

## 中文簡介

TripTrace Research 會把多部 YouTube 旅遊影片整理成一份可以回到原始證據的地點指南。每個重點都有逐字字幕、時間戳、影片來源、畫面與位置驗證。系統會排除其他街區、只是順帶提到、字幕無法支持，或距離查詢點太遠的餐廳與景點。

研究過程不是全部完成才顯示：已通過驗證的分類會先出現，其餘分類繼續搜尋。Verification funnel 會呈現影片候選、字幕來源、候選片段、證據通過與位置通過的真實數字。

## License

This project is available under the [MIT License](LICENSE).
