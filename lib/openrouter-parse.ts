// Pure response parsing, split out of lib/openrouter.ts so it can be
// unit-tested with a fixture directly under plain node -- openrouter.ts
// itself imports "server-only", which throws outside a Next.js server bundle.
import { coerceExtractedBill, type GroqExtractResult } from "./groq.ts";

// OpenRouter's chat completions response is OpenAI-compatible -- same
// choices[0].message.content shape Groq itself already returns.
export function parseOpenRouterResponse(json: unknown): GroqExtractResult {
  const choices = (json as Record<string, unknown> | null)?.choices;
  const message = Array.isArray(choices) ? (choices[0] as Record<string, unknown> | undefined)?.message : undefined;
  const text = (message as Record<string, unknown> | undefined)?.content;
  if (typeof text !== "string") {
    return { ok: false, kind: "extraction_failed", detail: "no content in OpenRouter response" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, kind: "extraction_failed", detail: "model did not return valid JSON" };
  }

  const data = coerceExtractedBill(parsed);
  if (!data) {
    return { ok: false, kind: "extraction_failed", detail: "model JSON did not match the expected shape" };
  }
  return { ok: true, data };
}
