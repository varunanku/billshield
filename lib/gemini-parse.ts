// Pure response parsing, split out of lib/gemini.ts so it can be
// unit-tested with a fixture directly under plain node -- gemini.ts itself
// imports "server-only", which throws outside a Next.js server bundle.
import { coerceExtractedBill, type GroqExtractResult } from "./groq.ts";

export function parseGeminiResponse(json: unknown): GroqExtractResult {
  const candidates = (json as Record<string, unknown> | null)?.candidates;
  const raw = Array.isArray(candidates)
    ? ((candidates[0] as Record<string, unknown> | undefined)?.content as Record<string, unknown> | undefined)
        ?.parts
    : undefined;
  const text = Array.isArray(raw) ? (raw[0] as Record<string, unknown> | undefined)?.text : undefined;
  if (typeof text !== "string") {
    return { ok: false, kind: "extraction_failed", detail: "no content in Gemini response" };
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
