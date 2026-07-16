import { NextResponse } from "next/server";
import { researchPlace } from "@/lib/research-server";
import { researchPlaceRequestSchema } from "@/lib/schemas";
import type { ResearchStreamEvent } from "@/types/research";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const recentRequests = new Map<string, number[]>();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 5;

function clientKey(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

function rateLimited(key: string) {
  const now = Date.now();
  const active = (recentRequests.get(key) || []).filter((time) => now - time < RATE_WINDOW_MS);
  if (active.length >= RATE_LIMIT) return true;
  recentRequests.set(key, [...active, now]);
  return false;
}

export async function POST(request: Request) {
  const traceId = crypto.randomUUID();
  let input;
  try {
    input = researchPlaceRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Enter a normal place and city name between 2 and 80 characters.", traceId }, { status: 400 });
  }

  if (rateLimited(clientKey(request))) {
    return NextResponse.json({ error: "Too many new-place research runs. Wait a few minutes or use a cached result.", traceId }, { status: 429 });
  }

  const encoder = new TextEncoder();
  const startedAt = Date.now();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ResearchStreamEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const result = await researchPlace({
          ...input,
          signal: request.signal,
          onProgress(stage, message, completed, total) {
            send({ type: "progress", stage, message, completed, total, elapsedMs: Date.now() - startedAt });
          }
        });
        send({ type: "result", result });
      } catch (error) {
        const aborted = request.signal.aborted || (error instanceof Error && error.name === "AbortError");
        if (!aborted) {
          const message = error instanceof Error ? error.message : "The research run failed.";
          console.error("[research-place] failed", { traceId, message });
          send({ type: "error", message, recoverable: true });
        }
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      "X-Trace-Id": traceId
    }
  });
}
