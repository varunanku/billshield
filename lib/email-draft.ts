// Server-only. The LLM here does exactly one job: word an email around a
// facts object code already built (lib/verdict.ts) -- it never computes or
// states a number that isn't in those facts. Enforced twice: the prompt
// says so, and allNumbersAreFacts checks the actual output afterwards.
// GROQ_API_KEY never reaches the browser; only imported from Route Handlers.
import type { Facts } from "./verdict.ts";

const EMAIL_MODEL = "qwen/qwen3.8-27b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export type Tone = "confident" | "inquiry";
export type EmailDraft = { subject: string; body: string };

// Every money figure the email is allowed to state, derived from facts
// alone -- nothing here was ever at the LLM's discretion.
function factNumbers(facts: Facts): number[] {
  const numbers = [facts.billedAmount, facts.total, Math.abs(facts.gap)];
  if (facts.promisedAmount !== null) numbers.push(facts.promisedAmount);
  for (const line of facts.disputedLines) numbers.push(line.amount);
  return numbers;
}

// Money-shaped tokens only -- a plain decimal with exactly 2 digits,
// optionally rupee-prefixed -- not every digit sequence. A date ("19
// October 2026") or a percentage ("18%") in the prose must not false-
// trigger this guard; every amount this app ever hands the model is
// formatted to 2 decimal places, so that shape is the actual signature of
// "this is a money figure" in the output.
const MONEY_TOKEN = /₹?\s*\d[\d,]*\.\d{2}/g;

export function extractMoneyNumbers(text: string): number[] {
  const matches = text.match(MONEY_TOKEN) ?? [];
  return matches.map((m) => Number(m.replace(/[₹,\s]/g, "")));
}

const NUMBER_EPSILON = 0.01;

// True only if every money-shaped number in the draft traces back to the
// facts object. This is the actual enforcement of "the LLM never states a
// number it wasn't given" -- the prompt alone is a request, not a guarantee.
export function allNumbersAreFacts(draft: EmailDraft, facts: Facts): boolean {
  const allowed = factNumbers(facts);
  const found = extractMoneyNumbers(`${draft.subject} ${draft.body}`);
  return found.every((n) => allowed.some((a) => Math.abs(a - n) <= NUMBER_EPSILON));
}

function buildPrompt(facts: Facts, tone: Tone): string {
  const lineText =
    facts.disputedLines.length > 0
      ? facts.disputedLines.map((l) => `- ${l.label}: Rs ${l.amount.toFixed(2)}`).join("\n")
      : "(no single line identified -- write generally about the billed total)";

  return `Write a short, polite email to a service provider about a billing question. Use ONLY the facts listed below. Never state, compute, infer, or round any amount that is not explicitly given here -- if you need a number, it must be one of these exact figures.

Provider: ${facts.provider}
Bill date: ${facts.billDate}
Printed total: Rs ${facts.total.toFixed(2)}
Billed amount (as reconciled by the user): Rs ${facts.billedAmount.toFixed(2)}
${facts.promisedAmount !== null ? `Promised amount: Rs ${facts.promisedAmount.toFixed(2)}\n` : ""}Disputed line(s):
${lineText}
Difference: Rs ${Math.abs(facts.gap).toFixed(2)} (${facts.gap >= 0 ? "the user appears to have been undercharged or owes more" : "the user appears to have overpaid"})

Tone: ${
    tone === "confident"
      ? "Confident and direct. State the issue plainly and ask for a correction or a refund."
      : "Soft and inquiry-based. Ask the provider to confirm or clarify -- do not accuse them of an error."
  }

Return ONLY a JSON object of this exact shape, no other text: {"subject": string, "body": string}.`;
}

async function callModel(facts: Facts, tone: Tone): Promise<EmailDraft | null> {
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EMAIL_MODEL,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: buildPrompt(facts, tone) }],
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const raw = json?.choices?.[0]?.message?.content;
    if (typeof raw !== "string") return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.subject !== "string" || typeof parsed.body !== "string") return null;
    return { subject: parsed.subject, body: parsed.body };
  } catch {
    return null;
  }
}

// Code-built fallback: used whenever the model's draft fails the number
// guard twice in a row, or the call itself fails. Every number here is
// read straight from facts, not generated.
export function templateEmail(facts: Facts, tone: Tone): EmailDraft {
  const lineText =
    facts.disputedLines.length > 0
      ? facts.disputedLines.map((l) => `${l.label} (Rs ${l.amount.toFixed(2)})`).join(", ")
      : "the charge in question";

  if (tone === "confident") {
    const overpaid = facts.gap < 0;
    return {
      subject: `Billing discrepancy on my ${facts.billDate} bill`,
      body: `Dear ${facts.provider} Support,

My bill dated ${facts.billDate} shows a total of Rs ${facts.total.toFixed(2)}. The amounts I can verify come to Rs ${facts.billedAmount.toFixed(2)}, a difference of Rs ${Math.abs(facts.gap).toFixed(2)}${overpaid ? ", which I appear to have overpaid" : ""}.${
        facts.disputedLines.length > 0 ? ` This concerns ${lineText}.` : ""
      }

Could you please review this and ${overpaid ? "advise on a refund or credit" : "correct the charge"}? I'd appreciate a reference number for this query.

Regards,
[Name]`,
    };
  }

  return {
    subject: `Question about my ${facts.billDate} bill`,
    body: `Dear ${facts.provider} Support,

I have a question about my bill dated ${facts.billDate} (total Rs ${facts.total.toFixed(2)}). ${
      facts.disputedLines.length > 0
        ? `Could you confirm whether ${lineText} is correct and still applicable to my account?`
        : "Could you confirm the charges on this bill are correct?"
    }${facts.promisedAmount !== null ? ` I was told to expect around Rs ${facts.promisedAmount.toFixed(2)}.` : ""}

Thank you,
[Name]`,
  };
}

export async function draftEmail(facts: Facts, tone: Tone): Promise<EmailDraft> {
  let draft = await callModel(facts, tone);
  if (draft && !allNumbersAreFacts(draft, facts)) {
    draft = await callModel(facts, tone); // one regeneration attempt
  }
  if (!draft || !allNumbersAreFacts(draft, facts)) {
    return templateEmail(facts, tone);
  }
  return draft;
}
