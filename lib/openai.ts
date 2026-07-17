import OpenAI from "openai";

export type TripTraceRuntime = "development" | "production";

/**
 * The runtime is explicit so a local Next production build cannot silently
 * spend the production budget. Cloud Run sets this to `production`; local
 * development defaults to the cheaper nano model.
 */
export const TRIPTRACE_RUNTIME: TripTraceRuntime = process.env.TRIPTRACE_RUNTIME === "production"
  ? "production"
  : "development";

export const TRIPTRACE_TEST_MODE = TRIPTRACE_RUNTIME === "development" && process.env.TRIPTRACE_TEST_MODE === "fixture";
export const PRODUCTION_OPENAI_MODEL = "gpt-5.6-luna";
export const DEFAULT_DEVELOPMENT_OPENAI_MODEL = "gpt-5.4-nano";

export function resolveOpenAIModel(options: {
  runtime?: TripTraceRuntime;
  developmentModel?: string;
} = {}) {
  if ((options.runtime || TRIPTRACE_RUNTIME) === "production") return PRODUCTION_OPENAI_MODEL;
  return options.developmentModel?.trim() || process.env.OPENAI_DEV_MODEL?.trim() || DEFAULT_DEVELOPMENT_OPENAI_MODEL;
}

export const OPENAI_MODEL = resolveOpenAIModel();

export function getOpenAIClient() {
  if (TRIPTRACE_TEST_MODE || !process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60_000, maxRetries: 0 });
}
