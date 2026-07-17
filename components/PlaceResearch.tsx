"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Clock3, ExternalLink, LoaderCircle, MapPin, Play, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import taipei101Demo from "@/data/taipei-101-demo.json";
import type { PlaceResearchResult, ResearchIntent, ResearchStage, ResearchStreamEvent } from "@/types/research";

const STAGES: Array<{ id: ResearchStage; label: string }> = [
  { id: "search", label: "Search videos" },
  { id: "screen", label: "Check sources" },
  { id: "captions", label: "Read captions" },
  { id: "extract", label: "Match clips" },
  { id: "synthesize", label: "Build visit plan" }
];

const SECTION_LABELS: Record<ResearchIntent, string> = {
  why_visit: "Why it’s worth going",
  activity: "What to do",
  food: "What to eat",
  practical_tip: "Good to know"
};

const EXAMPLE_PLACES = ["Ximending", "Dadaocheng", "Shilin Night Market"];
const TAIPEI_101_DEMO = taipei101Demo as PlaceResearchResult;
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

export function PlaceResearch() {
  const [place, setPlace] = useState("Taipei 101");
  const [city, setCity] = useState("Taipei");
  const [force, setForce] = useState(false);
  const [status, setStatus] = useState<"idle" | "running" | "success" | "error" | "cancelled">("idle");
  const [progress, setProgress] = useState<Extract<ResearchStreamEvent, { type: "progress" }> | null>(null);
  const [result, setResult] = useState<PlaceResearchResult | null>(TAIPEI_101_DEMO);
  const [error, setError] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const startedAtRef = useRef(0);

  useEffect(() => {
    if (status !== "running") return;
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 500);
    return () => window.clearInterval(timer);
  }, [status]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const controller = new AbortController();
    controllerRef.current = controller;
    startedAtRef.current = Date.now();
    setStatus("running");
    setProgress(null);
    setResult(null);
    setError("");
    setElapsedMs(0);

    try {
      const response = await fetch("/api/research-place", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ place, city, force }),
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
    } finally {
      controllerRef.current = null;
    }
  }

  function cancel() {
    controllerRef.current?.abort();
  }

  const progressPercent = progress ? Math.round((progress.completed / progress.total) * 100) : 4;
  const activeStageIndex = progress ? Math.max(0, STAGES.findIndex((stage) => stage.id === progress.stage)) : 0;

  return (
    <div className="research-workspace">
      <section className="research-intro">
        <div className="eyebrow"><Search size={14} /> On-demand source research</div>
        <h1>Research a new place from real travel videos.</h1>
        <p>Enter one place. TripTrace searches several recent video angles, checks timed captions, and returns a visit outline whose claims still open at the supporting moment.</p>
      </section>

      <section className="research-panel">
        <form className="research-form" onSubmit={submit}>
          <div className="research-form-heading"><div><span>New place</span><h2>What should we investigate?</h2></div><Clock3 size={20} /></div>
          <label><span>Place</span><input value={place} onChange={(event) => setPlace(event.target.value)} placeholder="e.g. Dadaocheng" disabled={status === "running"} required minLength={2} maxLength={80} /></label>
          <label><span>City</span><input value={city} onChange={(event) => setCity(event.target.value)} placeholder="Taipei" disabled={status === "running"} required minLength={2} maxLength={80} /></label>
          <div className="research-examples"><span>Try another Taipei place:</span>{EXAMPLE_PLACES.map((example) => <button type="button" key={example} disabled={status === "running"} onClick={() => setPlace(example)}>{example}</button>)}</div>
          <label className="research-force"><input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} disabled={status === "running"} /><span>Ignore saved result and research again</span></label>
          {status === "running" ? <button className="research-cancel" type="button" onClick={cancel}><X size={17} />Cancel research</button> : <button className="primary-button" type="submit"><span>{result?.demoSnapshot ? "Research live" : result ? "Research another place" : "Research this place"}</span><Search size={18} /></button>}
          <p className="research-boundary"><ShieldCheck size={13} />Runs only after you submit. Captions, metadata, and storyboard frames only—no video stream download.</p>
        </form>

        <div className={`research-progress ${status}`} aria-live="polite">
          {status === "idle" && <div className="research-idle"><Search size={27} /><h3>Ready when you are</h3><p>A fresh place usually takes 30–90 seconds. Saved research loads immediately.</p></div>}
          {status === "running" && <>
            <div className="progress-heading"><div><span>Live research</span><h3>{progress?.message || "Starting a source research run…"}</h3></div><strong>{formatElapsed(elapsedMs)}</strong></div>
            <div className="progress-track"><span style={{ width: `${progressPercent}%` }} /></div>
            <ol>{STAGES.map((stage, index) => <li key={stage.id} className={index < activeStageIndex || progress?.stage === "complete" ? "done" : index === activeStageIndex ? "active" : ""}>{index < activeStageIndex || progress?.stage === "complete" ? <Check size={13} /> : index === activeStageIndex ? <LoaderCircle className="spin" size={13} /> : <span />}{stage.label}</li>)}</ol>
          </>}
          {status === "cancelled" && <div className="research-idle"><X size={25} /><h3>Research cancelled</h3><p>No result was saved. Change the place or start again when ready.</p></div>}
          {status === "error" && <div className="research-idle error"><AlertTriangle size={25} /><h3>Research stopped</h3><p>{error}</p><button type="button" onClick={() => setStatus("idle")}><RefreshCw size={13} />Try again</button></div>}
          {status === "success" && result && <div className="research-complete"><Check size={27} /><div><span>{result.cacheHit ? "Saved research" : "Fresh research"}</span><h3>{result.sourceCount} videos · {result.clipCount} timestamped clips</h3><p>Completed in {formatElapsed(elapsedMs)} using {result.mode === "ai" ? `${result.aiModel || "OpenAI"} synthesis with deterministic timestamps` : result.mode === "fixture" ? "local fixture mode (no API call)" : "transcript-only fallback"}.</p></div></div>}
        </div>
      </section>

      {result && <section className="research-result">
        <header><div><span className="drawer-kicker">{result.demoSnapshot ? `Verified demo snapshot · ${new Date(result.generatedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}` : status === "running" ? "Verified so far · research continues" : "Source-backed place brief"}</span><h2>{result.place}</h2><p>{result.city}</p></div><div className="research-result-stats"><strong>{result.sourceCount}</strong><span>videos</span><strong>{result.clipCount}</strong><span>clips</span></div></header>
        <p className="research-overview">{result.overview}</p>
        <VerificationFunnel result={result} running={status === "running"} />
        <p className="research-coverage"><strong>{new Set(result.clips.map((clip) => clip.intent)).size}/4 categories covered</strong> · Missing categories stay explicit until a matching caption segment passes validation.</p>
        <div className="research-plan"><span>Suggested visit outline</span><ol>{result.suggestedPlan.map((step, index) => <li key={`${step}-${index}`}><strong>{String(index + 1).padStart(2, "0")}</strong>{step}</li>)}</ol></div>
        <div className="research-sections">{(Object.keys(SECTION_LABELS) as ResearchIntent[]).map((intent) => {
          const clips = result.clips.filter((clip) => clip.intent === intent);
          return <section key={intent}><h3>{SECTION_LABELS[intent]}</h3>{clips.length ? <div className="research-clips">{clips.map((clip) => {
            const youtubeUrl = `https://www.youtube.com/watch?v=${clip.video.id}&t=${clip.startSeconds}s`;
            const imageAlt = clip.frameDataUrl
              ? `Video frame from ${clip.video.title} near ${timestamp(clip.frameSeconds ?? clip.startSeconds)}`
              : `YouTube thumbnail for ${clip.video.title}`;
            return <article key={clip.id} className="research-clip"><a className="research-thumbnail" href={youtubeUrl} target="_blank" rel="noreferrer"><Image src={clip.frameDataUrl || clip.video.thumbnailUrl} alt={imageAlt} fill unoptimized={Boolean(clip.frameDataUrl)} sizes="(max-width: 680px) 100vw, 520px" /><span><Play size={12} fill="currentColor" />{timestamp(clip.startSeconds)}</span></a><div><span className="research-source-meta">{clip.video.channelName} · {clip.captionTrack} captions · {formatPublishedAt(clip.video.publishedAt)}</span>{clip.locationVerification && clip.locationVerification.status !== "pending" && <span className="research-location"><MapPin size={10} />{locationLabel(result, clip.locationVerification.distanceMeters, clip.locationVerification.relationship)}</span>}<h4>{clip.title}</h4><span className="research-takeaway-label">Key takeaway</span><p className="research-takeaway">{highlightedTakeaway(clip.takeaway, clip.highlights)}</p><details><summary>Read exact transcript</summary><blockquote>“{clip.exactQuote}”</blockquote></details><a href={youtubeUrl} target="_blank" rel="noreferrer">Open source at {timestamp(clip.startSeconds)} <ExternalLink size={12} /></a></div></article>;
          })}</div> : <p className="research-gap">{CATEGORY_GAP_COPY[intent]}</p>}</section>;
        })}</div>
        <div className="research-warnings">{result.warnings.map((warning) => <p key={warning}><AlertTriangle size={13} />{warning}</p>)}{result.clips.some((clip) => clip.locationVerification) && <p><MapPin size={13} />Location checks use <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> data.</p>}</div>
      </section>}
    </div>
  );
}
