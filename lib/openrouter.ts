// Server-only OpenRouter client -- same job as lib/groq.ts (extract a bill
// into the shared ExtractedBill shape; answer the follow-up chat), routed
// through OpenRouter's OpenAI-compatible endpoint instead of calling a
// provider's API directly. OPENROUTER_API_KEY never reaches the browser;
// this module is only imported from Route Handlers.
import "server-only";

import { EXTRACTION_PROMPT, type ChatResult, type ChatTurn, type ExtractedBill, type GroqExtractResult, type ImageInput } from "./groq.ts";
import { parseOpenRouterResponse } from "./openrouter-parse.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// Shown in OpenRouter's dashboard/rankings -- required-ish headers for
// using the service, not a secret.
const SITE_URL = "https://billshield-tau.vercel.app";
const SITE_TITLE = "BillShield";

function model(): string {
  return process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-001";
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY ?? ""}`,
    "Content-Type": "application/json",
    "HTTP-Referer": SITE_URL,
    "X-Title": SITE_TITLE,
  };
}

type ContentPart = { type: "image_url"; image_url: { url: string } };

// OpenAI-compatible vision format, same image part shape Groq itself uses
// -- the extraction prompt goes in the system message here instead of a
// leading text part, since OpenRouter (like OpenAI) supports a system role.
function buildImageContent(images: ImageInput[]): ContentPart[] {
  return images.map((image) => ({
    type: "image_url",
    image_url: { url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}` },
  }));
}

export async function extractBillFromImages(images: ImageInput[]): Promise<GroqExtractResult> {
  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: model(),
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: EXTRACTION_PROMPT },
          { role: "user", content: buildImageContent(images) },
        ],
      }),
    });
  } catch (e) {
    return { ok: false, kind: "extraction_failed", detail: `network error: ${String(e)}` };
  }

  if (res.status === 429) {
    const retryAfterHeader = res.headers.get("retry-after");
    return {
      ok: false,
      kind: "rate_limited",
      retryAfterSeconds: retryAfterHeader ? Number(retryAfterHeader) : null,
    };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    return { ok: false, kind: "extraction_failed", detail };
  }

  const json = await res.json().catch(() => null);
  return parseOpenRouterResponse(json);
}

// Text-only chat, same model as extraction, for the post-verdict follow-up
// Q&A -- plain OpenAI-style messages, no images.
export async function answerFollowupQuestion(systemPrompt: string, history: ChatTurn[]): Promise<ChatResult> {
  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: model(),
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: systemPrompt }, ...history],
      }),
    });
  } catch (e) {
    return { ok: false, kind: "failed", detail: `network error: ${String(e)}`, transient: true };
  }

  if (res.status === 429) {
    const retryAfterHeader = res.headers.get("retry-after");
    return {
      ok: false,
      kind: "rate_limited",
      retryAfterSeconds: retryAfterHeader ? Number(retryAfterHeader) : null,
    };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    return { ok: false, kind: "failed", detail, transient: res.status >= 500 };
  }

  const json = await res.json().catch(() => null);
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    return { ok: false, kind: "failed", detail: "no content in OpenRouter response", transient: true };
  }
  return { ok: true, text };
}

export type { ExtractedBill };
