"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Clock3, ExternalLink, LoaderCircle, MapPin, Play, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import type { PlaceResearchResult, ResearchIntent, ResearchStage, ResearchStreamEvent } from "@/types/research";

const STAGES: Array<{ id: ResearchStage; label: string }> = [
  { id: "search", label: "Search videos" },
  { id: "screen", label: "Check sources" },
  { id: "captions", label: "Read captions" },
  { id: "extract", label: "Match clips" },
  { id: "synthesize", label: "Build visit plan" }
];

const INITIAL_SNAPSHOT_REPLAY: Array<{ stage: ResearchStage; message: string }> = [
  { stage: "search", message: "Checking the bundled verified snapshot…" },
  { stage: "screen", message: "Rechecking saved video-source coverage…" },
  { stage: "captions", message: "Loading saved timed-caption evidence…" },
  { stage: "extract", message: "Restoring verified transcript matches…" },
  { stage: "synthesize", message: "Preparing the source-backed visit outline…" }
];

const SECTION_LABELS: Record<ResearchIntent, string> = {
  why_visit: "Why it’s worth going",
  activity: "What to do",
  food: "What to eat",
  practical_tip: "Good to know"
};

const EXAMPLE_PLACES = ["Ximending", "Dadaocheng", "Shilin Night Market"];
const CATEGORY_GAP_COPY: Record<ResearchIntent, string> = {
  why_visit: "No verified reason-to-visit evidence is available yet. TripTrace keeps this empty instead of filling it with a generic city description.",
  activity: "No verified activity tied to this place is available yet. A casually mentioned museum, street, or attraction is not promoted here.",
  food: "No verified food or drink recommendation is available yet. Incidental food words are not treated as a dining suggestion.",
  practical_tip: "No verified timing, access, queue, transport, or payment tip is available yet. Current details still need a live check."
};

function timestamp(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatElapsed(milliseconds: number) {
  return `${Math.max(0, Math.round(milliseconds / 1000))}s`;
}

function formatPublishedAt(publishedAt?: string) {
  if (!publishedAt) return "publication date unavailable";
  const parsed = new Date(`${publishedAt}T12:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? "publication date unavailable" : `published ${parsed.toLocaleDateString("en-US", { month: "short", year: "numeric" })}`;
}

function locationLabel(result: PlaceResearchResult, distanceMeters: number, relationship: "queried_place" | "inside" | "nearby") {
  if (relationship === "inside") return `Inside ${result.place}`;
  if (relationship === "queried_place") return `At ${result.place}`;
  return distanceMeters < 1_000 ? `${distanceMeters} m from ${result.place}` : `${(distanceMeters / 1_000).toFixed(1)} km from ${result.place}`;
}

function highlightedTakeaway(value: string, highlights: string[] = []) {
  const terms = [...new Set(highlights.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!terms.length) return value;
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const matcher = new RegExp(`(${escaped.join("|")})`, "gi");
  const normalizedTerms = new Set(terms.map((term) => term.toLowerCase()));
  return value.split(matcher).map((part, index) => normalizedTerms.has(part.toLowerCase()) ? <mark key={`${part}-${index}`}>{part}</mark> : part);
}

function VerificationFunnel({ result, running }: { result: PlaceResearchResult; running: boolean }) {
  const verification = result.verification;
  if (!verification) return null;
  const coveredCategories = new Set(result.clips.map((clip) => clip.intent)).size;
  const steps = [
    ["Video candidates", verification.videosFound],
    ["Captioned sources", verification.captionedVideos],
    ["Candidate clips", verification.candidateClips],
    ["Evidence matches", verification.evidenceMatches],
    ["Location verified", verification.verifiedClips]
  ] as const;
  const excluded = verification.rejectedEvidenceOrRanking + verification.rejectedLocation;

  return <section className="verification-funnel" aria-label="Verification funnel">
    <div className="verification-heading"><div><span>How this result was verified</span><h3>{running ? "Verified results are ready while research continues." : result.mode === "extractive" ? `${coveredCategories}/4 categories have transcript evidence; semantic verification was unavailable.` : `${coveredCategories}/4 categories have verified evidence.`}</h3></div><ShieldCheck size={22} /></div>
    <ol>{steps.map(([label, value], index) => <li key={label}><strong>{value}</strong><span>{label}</span>{index < steps.length - 1 && <i aria-hidden="true">→</i>}</li>)}</ol>
    <div className="verification-rejections"><span>{excluded} excluded after clip extraction</span><p><b>{verification.rejectedEvidenceOrRanking}</b> unsupported, off-topic, duplicate, or lower-ranked</p><p><b>{verification.rejectedLocation}</b> unresolved or outside the allowed distance</p></div>
  </section>;
}

export function PlaceResearch({ initialResult = null }: { initialResult?: PlaceResearchResult | null }) {
  const [place, setPlace] = useState("Taipei 101");
  const [city, setCity] = useState("Taipei");
  const [status, setStatus] = useState<"idle" | "running" | "success" | "error" | "cancelled">("idle");
  const [progress, setProgress] = useState<Extract<ResearchStreamEvent, { type: "progress" }> | null>(null);
  const [result, setResult] = useState<PlaceResearchResult | null>(null);
  const [error, setError] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);
  // The bundled Taipei 101 snapshot follows the same completion behavior as
  // every later user query. A real pointer, key, touch, or wheel action during
  // its replay still cancels this one automatic move.
  const [autoScrollArmed, setAutoScrollArmed] = useState(Boolean(initialResult));
  const [initialReplay, setInitialReplay] = useState(Boolean(initialResult));
  const controllerRef = useRef<AbortController | null>(null);
  const startedAtRef = useRef(0);
  const resultSectionRef = useRef<HTMLElement | null>(null);
  const userInterruptedScrollRef = useRef(false);
  const initialReplayActiveRef = useRef(Boolean(initialResult));

  useEffect(() => {
    if (status !== "running") return;
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 500);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => {
    if (!initialResult) return;
    initialReplayActiveRef.current = true;
    let timeout: number | null = null;
    const replay = (index: number) => {
      if (!initialReplayActiveRef.current) return;
      if (index >= INITIAL_SNAPSHOT_REPLAY.length) {
        setResult(initialResult);
        setProgress(null);
        setInitialReplay(false);
        return;
      }
      const current = INITIAL_SNAPSHOT_REPLAY[index];
      setProgress({ type: "progress", stage: current.stage, message: current.message, completed: index, total: INITIAL_SNAPSHOT_REPLAY.length, elapsedMs: index * 800 });
      timeout = window.setTimeout(() => replay(index + 1), 800);
    };
    replay(0);
    return () => {
      initialReplayActiveRef.current = false;
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [initialResult]);

  useEffect(() => {
    if (!autoScrollArmed) return;
    const markUserIntent = () => { userInterruptedScrollRef.current = true; };
    window.addEventListener("wheel", markUserIntent, { passive: true });
    window.addEventListener("touchstart", markUserIntent, { passive: true });
    window.addEventListener("keydown", markUserIntent);
    // Removing the previous result can cause a browser layout scroll. That is
    // not a user interruption and must not cancel the one allowed result jump.
    // Pointer input still catches scrollbar drags or a deliberate page click.
    window.addEventListener("pointerdown", markUserIntent, { passive: true });
    return () => {
      window.removeEventListener("wheel", markUserIntent);
      window.removeEventListener("touchstart", markUserIntent);
      window.removeEventListener("keydown", markUserIntent);
      window.removeEventListener("pointerdown", markUserIntent);
    };
  }, [autoScrollArmed]);

  useEffect(() => {
    const initialSnapshotReady = Boolean(initialResult) && !initialReplay && result === initialResult;
    if (!autoScrollArmed || (status !== "success" && !initialSnapshotReady)) return;
    if (!result?.clips.length || userInterruptedScrollRef.current) {
      setAutoScrollArmed(false);
      return;
    }
    const animationFrame = window.requestAnimationFrame(() => {
      if (!userInterruptedScrollRef.current) {
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        resultSectionRef.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
      }
      setAutoScrollArmed(false);
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [autoScrollArmed, initialReplay, initialResult, result, status]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const controller = new AbortController();
    controllerRef.current = controller;
    startedAtRef.current = Date.now();
    userInterruptedScrollRef.current = false;
    initialReplayActiveRef.current = false;
    setInitialReplay(false);
    setAutoScrollArmed(true);
    setStatus("running");
    setProgress(null);
    setResult(null);
    setError("");
    setElapsedMs(0);

    try {
      const response = await fetch("/api/research-place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ place, city }),
        signal: controller.signal
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "The research request could not start.");
      }
      if (!response.body) throw new Error("The browser could not read the research progress stream.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completedResult: PlaceResearchResult | null = null;
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines.filter(Boolean)) {
          const message = JSON.parse(line) as ResearchStreamEvent;
          if (message.type === "progress") {
            setProgress(message);
            setElapsedMs(message.elapsedMs);
          } else if (message.type === "partial_result") {
            setResult(message.result);
          } else if (message.type === "result") {
            completedResult = message.result;
            setResult(message.result);
          } else if (message.type === "error") {
            throw new Error(message.message);
          }
        }
        if (done) break;
      }
      if (!completedResult) throw new Error("The research stream ended before producing a result.");
      setStatus("success");
    } catch (caught) {
      if (controller.signal.aborted) {
        setStatus("cancelled");
      } else {
        setError(caught instanceof Error ? caught.message : "The research run failed.");
        setStatus("error");
      }
      setAutoScrollArmed(false);
    } finally {
      controllerRef.current = null;
    }
  }

  function cancel() {
    controllerRef.current?.abort();
  }

  const progressPercent = progress ? Math.round((progress.completed / progress.total) * 100) : 4;
  const activeStageIndex = progress ? Math.max(0, STAGES.findIndex((stage) => stage.id === progress.stage)) : 0;
  const isReplaying = status === "running" || initialReplay;

  return (
    <div className="research-workspace">
      <section className="research-intro">
        <div className="eyebrow"><Search size={14} /> On-demand source research</div>
        <h1>Research a new place from real travel videos.</h1>
        <p>Enter one place. TripTrace first replays saved verified video evidence, then shows a clear source-unavailable state when it cannot verify anything new.</p>
      </section>

      <section className="research-panel">
        <form className="research-form" onSubmit={submit}>
          <div className="research-form-heading"><div><span>New place</span><h2>What should we investigate?</h2></div><Clock3 size={20} /></div>
          <label><span>Place</span><input value={place} onChange={(event) => setPlace(event.target.value)} placeholder="e.g. Dadaocheng" disabled={status === "running"} required minLength={2} maxLength={80} /></label>
          <label><span>City</span><input value={city} onChange={(event) => setCity(event.target.value)} placeholder="Taipei" disabled={status === "running"} required minLength={2} maxLength={80} /></label>
          <div className="research-examples"><span>Try another Taipei place:</span>{EXAMPLE_PLACES.map((example) => <button type="button" key={example} disabled={status === "running"} onClick={() => setPlace(example)}>{example}</button>)}</div>
          {status === "running" ? <button className="research-cancel" type="button" onClick={cancel}><X size={17} />Cancel research</button> : <button className="primary-button" type="submit"><span>Find verified sources</span><Search size={18} /></button>}
          <p className="research-boundary"><ShieldCheck size={13} />Public requests replay a verified snapshot or seven-day cache first. They never bypass YouTube protections or download video streams.</p>
        </form>

        <div className={`research-progress ${status}`} aria-live="polite">
          {status === "idle" && !initialReplay && <div className="research-idle"><Search size={27} /><h3>Ready when you are</h3><p>Saved verified research replays in about four seconds. If no saved evidence exists, TripTrace says so clearly.</p></div>}
          {isReplaying && <>
            <div className="progress-heading"><div><span>Source check</span><h3>{progress?.message || "Checking saved source-backed research…"}</h3></div><strong>{formatElapsed(elapsedMs)}</strong></div>
            <div className="progress-track"><span style={{ width: `${progressPercent}%` }} /></div>
            <ol>{STAGES.map((stage, index) => <li key={stage.id} className={index < activeStageIndex || progress?.stage === "complete" ? "done" : index === activeStageIndex ? "active" : ""}>{index < activeStageIndex || progress?.stage === "complete" ? <Check size={13} /> : index === activeStageIndex ? <LoaderCircle className="spin" size={13} /> : <span />}{stage.label}</li>)}</ol>
          </>}
          {status === "cancelled" && <div className="research-idle"><X size={25} /><h3>Research cancelled</h3><p>No result was saved. Change the place or start again when ready.</p></div>}
          {status === "error" && <div className="research-idle error"><AlertTriangle size={25} /><h3>Research stopped</h3><p>{error}</p><button type="button" onClick={() => setStatus("idle")}><RefreshCw size={13} />Try again</button></div>}
          {status === "success" && result?.sourceStatus === "source_unavailable" && <div className="research-unavailable"><AlertTriangle size={27} /><div><span>Source unavailable</span><h3>No saved verified brief is available yet.</h3><p>{result.sourceUnavailable?.message}</p></div></div>}
          {status === "success" && result && result.sourceStatus !== "source_unavailable" && <div className="research-complete"><Check size={27} /><div><span>{result.sourceStatus === "verified_snapshot" ? "Verified snapshot" : result.cacheHit ? "Saved research" : "Local research"}</span><h3>{result.sourceCount} videos · {result.clipCount} timestamped clips</h3><p>Completed in {formatElapsed(elapsedMs)} using {result.sourceStatus === "verified_snapshot" || result.sourceStatus === "runtime_cache" ? "saved evidence replay (no OpenAI or yt-dlp call)" : result.mode === "ai" ? `${result.aiModel || "OpenAI"} synthesis with deterministic timestamps` : result.mode === "fixture" ? "local legacy fixture mode (no API call)" : "transcript-only fallback"}.</p></div></div>}
        </div>
      </section>

      {result && result.sourceStatus !== "source_unavailable" && <section className="research-result" ref={resultSectionRef} data-source-status={result.sourceStatus || "local_research"}>
        <header><div><span className="drawer-kicker">{result.sourceStatus === "verified_snapshot" ? `Verified snapshot · ${new Date(result.generatedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}` : result.sourceStatus === "runtime_cache" ? "Seven-day saved research" : status === "running" ? "Verified so far · research continues" : "Source-backed place brief"}</span><h2>{result.place}</h2><p>{result.city}</p></div><div className="research-result-stats"><strong>{result.sourceCount}</strong><span>videos</span><strong>{result.clipCount}</strong><span>clips</span></div></header>
        <p className="research-overview">{result.overview}</p>
        <VerificationFunnel result={result} running={status === "running"} />
        <p className="research-coverage"><strong>{new Set(result.clips.map((clip) => clip.intent)).size}/4 categories covered</strong> · Missing categories stay explicit until a matching caption segment passes validation.</p>
        <div className="research-plan"><span>Suggested visit outline</span><ol>{result.suggestedPlan.map((step, index) => <li key={`${step}-${index}`}><strong>{String(index + 1).padStart(2, "0")}</strong>{step}</li>)}</ol></div>
        <div className="research-sections">{(Object.keys(SECTION_LABELS) as ResearchIntent[]).map((intent) => {
          const clips = result.clips.filter((clip) => clip.intent === intent);
          return <section key={intent}><h3>{SECTION_LABELS[intent]}</h3>{clips.length ? <div className="research-clips">{clips.map((clip) => {
            const youtubeUrl = `https://www.youtube.com/watch?v=${clip.video.id}&t=${clip.startSeconds}s`;
            const presentation = clip.englishPresentation;
            const cardTitle = presentation?.title || clip.title;
            const cardTakeaway = presentation?.takeaway || clip.takeaway;
            const cardHighlights = presentation?.highlights || clip.highlights;
            const transcriptCopy = presentation?.exactQuote || clip.exactQuote;
            const channelName = presentation?.channelName || clip.video.channelName;
            const imageAlt = clip.frameDataUrl
              ? `Video frame supporting ${cardTitle} near ${timestamp(clip.frameSeconds ?? clip.startSeconds)}`
              : `YouTube thumbnail supporting ${cardTitle}`;
            return <article key={clip.id} className="research-clip"><a className="research-thumbnail" href={youtubeUrl} target="_blank" rel="noreferrer"><Image src={clip.frameDataUrl || clip.video.thumbnailUrl} alt={imageAlt} fill unoptimized={Boolean(clip.frameDataUrl)} sizes="(max-width: 680px) 100vw, 520px" /><span><Play size={12} fill="currentColor" />{timestamp(clip.startSeconds)}</span></a><div><span className="research-source-meta">{channelName} · {clip.captionTrack} captions · {formatPublishedAt(clip.video.publishedAt)}</span>{clip.locationVerification && clip.locationVerification.status !== "pending" && <span className="research-location"><MapPin size={10} />{locationLabel(result, clip.locationVerification.distanceMeters, clip.locationVerification.relationship)}</span>}<h4>{cardTitle}</h4><span className="research-takeaway-label">Key takeaway</span><p className="research-takeaway">{highlightedTakeaway(cardTakeaway, cardHighlights)}</p><details><summary>{presentation?.exactQuote ? "Read English transcript translation" : "Read exact transcript"}</summary><blockquote>“{transcriptCopy}”</blockquote>{presentation?.exactQuote && <p className="research-translation-note">English translation of the exact source transcript. The linked timestamp opens the original caption source.</p>}</details><a href={youtubeUrl} target="_blank" rel="noreferrer">Open source at {timestamp(clip.startSeconds)} <ExternalLink size={12} /></a></div></article>;
          })}</div> : <p className="research-gap">{CATEGORY_GAP_COPY[intent]}</p>}</section>;
        })}</div>
        <div className="research-warnings">{result.warnings.map((warning) => <p key={warning}><AlertTriangle size={13} />{warning}</p>)}{result.clips.some((clip) => clip.locationVerification) && <p><MapPin size={13} />Location checks use <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> data.</p>}</div>
      </section>}
    </div>
  );
}
