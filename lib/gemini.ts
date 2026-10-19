// Server-only Gemini client -- same job as lib/groq.ts (extract a bill into
// the shared ExtractedBill shape), different provider. GEMINI_API_KEY never
// reaches the browser; this module is only imported from Route Handlers.
import "server-only";

import { LINE_ROLES } from "./bill-checks.ts";
import {
  EXTRACTION_PROMPT,
  type ChatResult,
  type ChatTurn,
  type ExtractedBill,
  type GroqExtractResult,
  type ImageInput,
} from "./groq.ts";
import { parseGeminiResponse } from "./gemini-parse.ts";

// Gemini's inline PDF support means a PDF goes straight through as a part,
// just like an image -- no rasterizing step needed for this provider.
type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } };

function buildGeminiParts(images: ImageInput[]): GeminiPart[] {
  const parts: GeminiPart[] = [{ text: EXTRACTION_PROMPT }];
  for (const image of images) {
    parts.push({ inline_data: { mime_type: image.mimeType, data: image.bytes.toString("base64") } });
  }
  return parts;
}

// Mirrors the "role" enum rule from EXTRACTION_PROMPT as a response schema,
// so the model is constrained to a valid LineRole instead of just hoping.
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    provider: { type: "STRING", nullable: true },
    bill_date: { type: "STRING", nullable: true },
    total: { type: "NUMBER", nullable: true },
    line_items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          label: { type: "STRING" },
          amount: { type: "NUMBER" },
          role: { type: "STRING", enum: LINE_ROLES },
        },
        required: ["label", "amount", "role"],
      },
    },
  },
  required: ["provider", "bill_date", "total", "line_items"],
};

export async function extractBillFromImages(images: ImageInput[]): Promise<GroqExtractResult> {
  const model = process.env.GEMINI_MODEL;
  if (!model) {
    return { ok: false, kind: "extraction_failed", detail: "GEMINI_MODEL is not set" };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": process.env.GEMINI_API_KEY ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: buildGeminiParts(images) }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
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
  return parseGeminiResponse(json);
}

// Text-only chat, same model as extraction, for the post-verdict follow-up
// Q&A. Gemini has no "assistant" role -- history turns map to "model".
export async function answerFollowupQuestion(systemPrompt: string, history: ChatTurn[]): Promise<ChatResult> {
  const model = process.env.GEMINI_MODEL;
  if (!model) {
    return { ok: false, kind: "failed", detail: "GEMINI_MODEL is not set" };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const contents = history.map((turn) => ({
    role: turn.role === "assistant" ? "model" : "user",
    parts: [{ text: turn.content }],
  }));

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": process.env.GEMINI_API_KEY ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0 },
      }),
    });
  } catch (e) {
    return { ok: false, kind: "failed", detail: `network error: ${String(e)}` };
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
    return { ok: false, kind: "failed", detail };
  }

  const json = await res.json().catch(() => null);
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== "string") {
    return { ok: false, kind: "failed", detail: "no content in Gemini response" };
  }
  return { ok: true, text };
}

export type { ExtractedBill };
