// Server-only Groq client for the one vision model on this account that
// accepts images: qwen/qwen3.8-27b (max 3 images/request, 20MB/request,
// confirmed live against the account's own key -- see chat history).
// GROQ_API_KEY never reaches the browser; this module is only imported
// from Route Handlers.

import { LINE_ROLES, type LineRole } from "./bill-checks.ts";

const GROQ_MODEL = "qwen/qwen3.8-27b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export type ExtractedBill = {
  provider: string | null;
  provider_legal_name: string | null;
  bill_date: string | null;
  total: number | null;
  line_items: { label: string; amount: number; role: LineRole }[];
};

export type GroqExtractResult =
  | { ok: true; data: ExtractedBill }
  | { ok: false; kind: "rate_limited"; retryAfterSeconds: number | null }
  | { ok: false; kind: "extraction_failed"; detail: string };

// Exported so lib/gemini.ts reuses the exact same wording -- one prompt,
// not two copies that could drift apart as either gets tuned.
export const EXTRACTION_PROMPT = `You are reading a bill or receipt image. Return ONLY a single JSON object, no other text, matching exactly this shape:

{
  "provider": string or null,
  "provider_legal_name": string or null,
  "bill_date": string (YYYY-MM-DD) or null,
  "total": number or null,
  "line_items": [ { "label": string, "amount": number, "role": string } ]
}

Extract EVERY printed row of the charges/fees table that has its own printed
amount -- not just the headline rows. Many bills itemize a charge into
several components (for example, a surcharge or adjustment charged
separately on a fixed portion and an energy/usage portion): if the bill
prints "PPAC on Fixed Charge: 89.43" and "PPAC on Energy Charge: 1113.65" as
two separate rows, extract both as two separate line items, each with its
own printed label and amount -- do not merge them, and do not skip either
one because a different row already covers a related total.

Transcribe each label exactly as printed (same wording, same abbreviations),
not a paraphrase or a cleaned-up version.

Never output an amount that is not itself printed as its own standalone
figure next to a label. If you are not sure an amount is genuinely its own
printed line (as opposed to something you would need to add, subtract, or
infer to produce), omit that line entirely rather than guess.

Some bills print a row's label (sometimes with a letter code like "(G)" or
"(H)") but leave its amount cell blank, show only a dash/hyphen ("-"), or
show "0.00" or "0". A blank, dash, or zero amount means nothing is charged
on that line -- it is NOT something to estimate, infer, or fill in. A
printed label by itself is never enough to justify a line item: there must
also be a legible, non-zero number printed directly in that row's amount
position. If a row's amount cell is blank, a dash, or zero, omit that row
entirely -- do not output a line item for it, even if a neighboring row with
a similar label does have a printed amount.

"role" must be exactly one of: "charge", "tax", "discount", "payment", "balance", "subtotal", "info", "opening".
- "charge": a fee or service charge that is part of what's owed.
- "tax": a GST/tax line.
- "discount": an amount subtracted or credited, reducing what's owed (not a tax).
- "payment": an amount actually paid or received (e.g. "Paid Amount", "Amount Received").
- "balance": an outstanding, due, or credit balance (e.g. "Outstanding Amount", "Balance Due"). A
  row labelled "Total", "Grand Total", "Total Amount", "Final Total", "Amount
  Payable", or "Amount Due" is role "balance", NEVER "charge" -- it restates
  a total, it is not itself a new charge.
- "subtotal": a running or sub total line (not the final grand total -- that's the separate "total" field above). If the exact same subtotal amount is printed twice under two different labels (e.g. "Subtotal" and, right below it, "Amount Before Tax", both showing the same figure), extract it only once, as a single line item.
- "info": a non-monetary printed number that is not itself an amount owed or
  paid -- units consumed, kW/kVA, meter readings, a percentage rate, a
  tariff slab's unit count, or any other quantity that happens to have a
  number next to it but is not a charge. If a tariff/usage table breaks a
  charge down into slabs (e.g. "0-200 units @ Rs 3 = 633.00", "200-400
  units @ Rs 4.50 = 949.50", ...), give each individual slab row the role
  "info" (even though it has its own printed amount) and instead extract
  the table's own printed section total (e.g. "Total Energy Charge:
  7863.50") as a single "charge" line -- don't extract both the slabs and
  their total, since summing both would double count. A tariff slab row is
  never itself a "charge" line, under any label. For a statement with a
  summary block (previous balance, payments, fees, closing balance) plus a
  separate list of individual transactions, extract only the summary block
  as charge/tax/payment/opening/balance lines; give each individual
  transaction row the role "info" instead -- it's already reflected in the
  summary's totals, so extracting it again as a charge would double count.
- "opening": a statement's previous/opening balance carried forward from
  before this billing period (e.g. "Previous Balance").

An amount printed as part of one row belongs only to that row's own label.
Never take an amount from one row (including a tariff slab row) and assign
it to a different, separately labelled row elsewhere on the bill, even if
that other row's own cell is blank -- see the blank-cell rule above.

If an item row prints several amount columns -- for example a pre-tax
amount, a separate tax amount, and a tax-inclusive total, all for the same
item -- use the pre-tax (taxable) amount as that item's own "charge" amount,
not the tax-inclusive total; the tax itself gets its own separate "tax" line
as usual.

Arrears, late payment charges (LPSC), or similar fees that are printed
between a subtotal and the final amount payable are real charge lines that
come after that subtotal -- extract them with their own printed label and
amount, same as any other charge. Never relabel an amount to make it fit a
different row's label, and never invent a label for an amount, or an amount
for a label, that isn't printed together as a pair.

Rules:
- Only report what is actually printed on the bill. Never guess, infer or compute a value that is not legible.
- If a field is missing or illegible, use null (for provider/bill_date/total) or omit the line item.
- "bill_date": copy the year exactly as printed. If the bill prints a
  2-digit year (e.g. "24" or "'24"), expand it to the 2000s (20YY), never
  1900s -- a bill never predates the year 2000.
- "provider": the brand or product name the customer actually recognises --
  from the logo, letterhead, or product name (e.g. "Overleaf", "Airtel").
- "provider_legal_name": the registered company name, ONLY if separately
  printed (e.g. in small print, an address block, or a footer) and
  different from the brand -- for example a bill from "Overleaf" might
  print "Digital Science UK Limited" as the billing entity. If no such
  separate legal name is printed, or it's the same as the brand, use null.
  Never guess or infer one.
- "total" is the single grand total amount printed on the bill.
- "line_items" are the individual lines (label + amount + role) as printed, in the order they appear.
- Your only job for each line is to transcribe its printed label and amount and classify its role. Do not add up, multiply, net out, or otherwise calculate anything yourself.
- Do not invent a category, tax rate, or support contact.`;

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type ChatResult =
  | { ok: true; text: string }
  | { ok: false; kind: "rate_limited"; retryAfterSeconds: number | null }
  | { ok: false; kind: "failed"; detail: string };

// Text-only chat completion, same model/endpoint as extraction, for the
// post-verdict follow-up Q&A -- no images involved here.
export async function answerFollowupQuestion(systemPrompt: string, history: ChatTurn[]): Promise<ChatResult> {
  let res: Response;
  try {
    res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: systemPrompt }, ...history],
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
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    return { ok: false, kind: "failed", detail: "no content in Groq response" };
  }
  return { ok: true, text };
}

export type ImageInput = { bytes: Buffer; mimeType: string };

type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

// Pure and exported so the data-URL-per-image logic (in particular: using
// each image's own real mime type, not a hardcoded one) can be asserted
// directly without a network call -- see lib/groq.test.mjs.
export function buildImageContent(images: ImageInput[]): ContentPart[] {
  const content: ContentPart[] = [{ type: "text", text: EXTRACTION_PROMPT }];
  for (const image of images) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.bytes.toString("base64")}` },
    });
  }
  return content;
}

export async function extractBillFromImages(images: ImageInput[]): Promise<GroqExtractResult> {
  const content = buildImageContent(images);

  let res: Response;
  try {
    res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content }],
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
  const raw = json?.choices?.[0]?.message?.content;
  if (typeof raw !== "string") {
    return { ok: false, kind: "extraction_failed", detail: "no content in Groq response" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, kind: "extraction_failed", detail: "model did not return valid JSON" };
  }

  const data = coerceExtractedBill(parsed);
  if (!data) {
    return { ok: false, kind: "extraction_failed", detail: "model JSON did not match the expected shape" };
  }

  return { ok: true, data };
}

// Exported so lib/gemini.ts can parse its own response into the same shape
// without duplicating this coercion logic.
export function coerceExtractedBill(value: unknown): ExtractedBill | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;

  const lineItemsRaw = Array.isArray(v.line_items) ? v.line_items : [];
  const line_items = lineItemsRaw
    .map((li) => {
      if (typeof li !== "object" || li === null) return null;
      const item = li as Record<string, unknown>;
      const label = typeof item.label === "string" ? item.label : null;
      const amount = typeof item.amount === "number" ? item.amount : null;
      if (label === null || amount === null) return null;
      // Default to "charge" rather than dropping the line, so nothing the
      // model read gets silently lost -- the user can fix a wrong role on
      // the review screen, but can't fix a line that never showed up.
      const role: LineRole = LINE_ROLES.includes(item.role as LineRole) ? (item.role as LineRole) : "charge";
      return { label, amount, role };
    })
    .filter((x): x is { label: string; amount: number; role: LineRole } => x !== null);

  return {
    provider: typeof v.provider === "string" ? v.provider : null,
    provider_legal_name: typeof v.provider_legal_name === "string" ? v.provider_legal_name : null,
    bill_date: typeof v.bill_date === "string" ? v.bill_date : null,
    total: typeof v.total === "number" ? v.total : null,
    line_items,
  };
}
