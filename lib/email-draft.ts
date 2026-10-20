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

// A secondary style knob, layered on top of the confident/inquiry stance
// (which still decides accusing-vs-asking). Picked from the review
// screen's dropdown; null means the original, unstyled draft.
export const TONE_PRESETS = ["polite", "firm", "formal", "brief", "friendly", "escalation"] as const;
export type TonePreset = (typeof TONE_PRESETS)[number];

const PRESET_INSTRUCTIONS: Record<TonePreset, string> = {
  polite: "Extra polite and courteous -- soften the language throughout.",
  firm: "Firm and assertive without being rude -- make clear this needs a prompt resolution.",
  formal: "Formal business-letter register -- no contractions, no casual phrasing.",
  brief: "As brief as possible -- a few sentences only, minimal pleasantries.",
  friendly: "Warm and friendly, conversational but still professional.",
  escalation:
    "Firmer still, and note that you will escalate this to a formal complaint or the relevant ombudsman/regulator if it isn't resolved promptly.",
};

// Every money (or, for a tax finding, rate percentage) figure the email is
// allowed to state, derived from facts alone -- nothing here was ever at
// the LLM's discretion. Rate percentages are included because a rate
// written with 2 decimals (e.g. "18.00%") is money-shaped enough to match
// MONEY_TOKEN below -- without this, even templateEmail's own fixed
// wording would fail its own number guard.
function factNumbers(facts: Facts): number[] {
  const numbers = [facts.billedAmount, facts.total, Math.abs(facts.gap)];
  if (facts.promisedAmount !== null) numbers.push(facts.promisedAmount);
  for (const line of facts.disputedLines) numbers.push(line.amount);
  if (facts.taxFinding) numbers.push(facts.taxFinding.effectiveRatePercent, facts.taxFinding.expectedRatePercent);
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

// Stricter than "is this number somewhere in facts": if the draft calls a
// figure "the total" (or "totals"), that figure must specifically be
// facts.total -- not billedAmount or gap mislabelled as the total. A draft
// can be 100% fact-number-accurate per allNumbersAreFacts and still
// mislead this way (e.g. calling the billed amount "the total"), so this
// is a separate check, not folded into that one. Only checks the common
// "total ... <number>" direction, not a number followed later by "total".
const TOTAL_CLAIM = /\btotals?\b[^0-9₹]{0,20}(₹?\s*\d[\d,]*\.\d{2})/gi;

export function totalClaimsAreCorrect(draft: EmailDraft, facts: Facts): boolean {
  const text = `${draft.subject} ${draft.body}`;
  const matches = [...text.matchAll(TOTAL_CLAIM)];
  return matches.every((m) => Math.abs(Number(m[1].replace(/[₹,\s]/g, "")) - facts.total) <= NUMBER_EPSILON);
}

// Same idea as totalClaimsAreCorrect, for "difference": a draft that calls
// some other fact number (e.g. billedAmount) "the difference" would pass
// allNumbersAreFacts (it's a real fact number) while still misstating
// which figure the dispute is actually about.
const DIFFERENCE_CLAIM = /\bdifference\b[^0-9₹]{0,20}(₹?\s*\d[\d,]*\.\d{2})/gi;

export function differenceClaimsAreCorrect(draft: EmailDraft, facts: Facts): boolean {
  const text = `${draft.subject} ${draft.body}`;
  const matches = [...text.matchAll(DIFFERENCE_CLAIM)];
  return matches.every((m) => Math.abs(Number(m[1].replace(/[₹,\s]/g, "")) - Math.abs(facts.gap)) <= NUMBER_EPSILON);
}

function passesNumberGuard(draft: EmailDraft, facts: Facts): boolean {
  return allNumbersAreFacts(draft, facts) && totalClaimsAreCorrect(draft, facts) && differenceClaimsAreCorrect(draft, facts);
}

// True for cannot_verify's email specifically: an inquiry-tone draft with a
// real (non-zero) gap but no pinpointed line -- distinct from unexplained's
// inquiry draft, which always has either a disputed line or a zero gap
// (see lib/verdict.ts's baseFacts(0, ...) calls). Softer wording ("a small
// difference") rather than "could you confirm the charges are correct",
// since there's nothing specific to point at.
function isUnpinpointedGap(facts: Facts): boolean {
  return facts.disputedLines.length === 0 && Math.abs(facts.gap) > NUMBER_EPSILON;
}

// Exported so a test can assert the fact numbers it carries don't change
// across tone presets -- the same guarantee passesNumberGuard enforces on
// the model's actual output, checked one layer earlier, without a network call.
export function buildPrompt(facts: Facts, tone: Tone, preset: TonePreset | null): string {
  const lineText =
    facts.disputedLines.length > 0
      ? facts.disputedLines.map((l) => `- ${l.label}: Rs ${l.amount.toFixed(2)}`).join("\n")
      : "(no single line identified -- write generally about the billed total)";

  return `Write a short, polite email to a service provider about a billing question. Use ONLY the facts listed below. Never state, compute, infer, or round any amount that is not explicitly given here -- if you need a number, it must be one of these exact figures. Never refer to any figure as "the total" except the one explicitly labelled "Printed total" below -- do not call the billed amount, the difference, or any other figure "the total".

Provider: ${facts.provider}
Bill date: ${facts.billDate}
Printed total: Rs ${facts.total.toFixed(2)}
Billed amount (as reconciled by the user): Rs ${facts.billedAmount.toFixed(2)}
${facts.promisedAmount !== null ? `Promised amount: Rs ${facts.promisedAmount.toFixed(2)}\n` : ""}Disputed line(s):
${lineText}
Difference: Rs ${Math.abs(facts.gap).toFixed(2)} (${facts.gap >= 0 ? "the user appears to have been undercharged or owes more" : "the user appears to have overpaid"})
${facts.reconcilingBalanceLabel ? `Note: a line labelled "${facts.reconcilingBalanceLabel}" on the bill matches this difference exactly -- mention it as confirming the excess.\n` : ""}${
    facts.taxFinding
      ? `Tax finding (CONFIRMED): the computed tax rate on this bill is ${facts.taxFinding.effectiveRatePercent.toFixed(2)}%, higher than the reference rate of ${facts.taxFinding.expectedRatePercent}%${facts.taxFinding.hsnPrefix ? ` for HSN ${facts.taxFinding.hsnPrefix}` : ""}${facts.taxFinding.sourceUrl ? ` (source: ${facts.taxFinding.sourceUrl})` : ""}. The difference above (Rs ${Math.abs(facts.gap).toFixed(2)}) is the possible excess this higher rate would add. This is a confirmed computed finding, but never state as fact that the provider made an error -- only that the rate should be confirmed.\n`
      : ""
  }Tone: ${
    tone === "confident"
      ? facts.taxFinding
        ? `Confident and direct, but not accusatory about intent. State that the tax rate charged is higher than the reference rate for this item's HSN classification, ask the provider to confirm the tax classification applied, and ask them to refund the excess if the rate was applied in error. Do not state as fact that the provider is wrong -- frame it as something to confirm.`
        : `Confident and direct. State the issue plainly.${
          facts.gap < 0
            ? " Ask for a refund or an adjustment against the next bill."
            : " Ask for a correction."
        }`
      : isUnpinpointedGap(facts)
        ? `Soft and curious, NOT accusatory -- this is a small, unpinpointed difference, not a confirmed error. Say you'd like to understand a small difference of Rs ${Math.abs(facts.gap).toFixed(2)} on the bill, and ask where it comes from. Do not name a specific wrong charge.`
        : "Soft and inquiry-based. Ask the provider to confirm or clarify -- do not accuse them of an error."
  }
${preset ? `\nAdditional style instruction: ${PRESET_INSTRUCTIONS[preset]}\n` : ""}
Return ONLY a JSON object of this exact shape, no other text: {"subject": string, "body": string}.`;
}

async function callModel(facts: Facts, tone: Tone, preset: TonePreset | null): Promise<EmailDraft | null> {
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
        messages: [{ role: "user", content: buildPrompt(facts, tone, preset) }],
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

  if (tone === "confident" && facts.taxFinding) {
    const tf = facts.taxFinding;
    return {
      subject: `Tax rate query on my ${facts.billDate} bill`,
      body: `Dear ${facts.provider} Support,

The tax rate charged on my bill dated ${facts.billDate} works out to ${tf.effectiveRatePercent.toFixed(2)}%, which is higher than the ${tf.expectedRatePercent}% rate listed${tf.hsnPrefix ? ` for HSN ${tf.hsnPrefix}` : ""}${tf.sourceUrl ? ` (source: ${tf.sourceUrl})` : ""}.

Could you please confirm the tax classification applied to this charge, and refund the excess of Rs ${Math.abs(facts.gap).toFixed(2)} if it was applied in error? I'd appreciate a reference number for this query.

Regards,
[Your Name]`,
    };
  }

  if (tone === "confident") {
    const overpaid = facts.gap < 0;
    return {
      subject: overpaid ? `Overpayment on my ${facts.billDate} bill` : `Billing discrepancy on my ${facts.billDate} bill`,
      body: `Dear ${facts.provider} Support,

My bill dated ${facts.billDate} shows a total of Rs ${facts.total.toFixed(2)}. The amounts I can verify come to Rs ${facts.billedAmount.toFixed(2)}, a difference of Rs ${Math.abs(facts.gap).toFixed(2)}${overpaid ? ", which I appear to have overpaid" : ""}.${
        facts.disputedLines.length > 0 ? ` This concerns ${lineText}.` : ""
      }${
        facts.reconcilingBalanceLabel
          ? ` This matches the "${facts.reconcilingBalanceLabel}" line on my bill, confirming the excess.`
          : ""
      }

Could you please review this and ${overpaid ? "arrange a refund or an adjustment against my next bill" : "correct the charge"}? I'd appreciate a reference number for this query.

Regards,
[Your Name]`,
    };
  }

  if (isUnpinpointedGap(facts)) {
    return {
      subject: `A small difference on my ${facts.billDate} bill`,
      body: `Dear ${facts.provider} Support,

I'd like to understand a small difference of Rs ${Math.abs(facts.gap).toFixed(2)} on my bill dated ${facts.billDate}. The amounts I can check come to Rs ${facts.billedAmount.toFixed(2)}, against a printed total of Rs ${facts.total.toFixed(2)}. Could you help clarify where this difference comes from?

Thank you,
[Your Name]`,
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
[Your Name]`,
  };
}

// preset is a pure wording knob -- passesNumberGuard runs exactly the same
// regardless, since facts (the only source of any number) never changes.
// The template fallback ignores preset: it's a fixed-wording, code-only
// safety net for when the model fails the guard twice, not styled output.
export async function draftEmail(facts: Facts, tone: Tone, preset: TonePreset | null = null): Promise<EmailDraft> {
  let draft = await callModel(facts, tone, preset);
  if (draft && !passesNumberGuard(draft, facts)) {
    draft = await callModel(facts, tone, preset); // one regeneration attempt
  }
  if (!draft || !passesNumberGuard(draft, facts)) {
    return templateEmail(facts, tone);
  }
  return draft;
}

// The sign-off's "[Your Name]" placeholder (see templateEmail above -- the
// one identity detail every draft, model-written or fallback, is expected
// to carry) is swapped for the user's own first name in code, after the
// draft already exists -- never asked of the LLM itself, so there's
// nothing here for the number/content guard above to even reason about.
// Case-insensitive and whitespace-flexible: an AI-written draft doesn't
// reliably reproduce the fallback's exact casing/spacing (seen in the
// wild as "[your name]", "[ Your  Name ]", etc.), so this matches any of
// those rather than the one literal string templateEmail happens to use.
// The caller (app/api/bills/draft-email/route.ts) applies this on every
// draft, including a Regenerate, since both paths produce an EmailDraft
// the same way. Keeps the placeholder unchanged when there's no name.
const NAME_PLACEHOLDER = /\[\s*your\s+name\s*\]/gi;

export function applySignature(draft: EmailDraft, fullName: string | null): EmailDraft {
  const firstName = fullName?.trim().split(/\s+/)[0];
  if (!firstName) return draft;
  return { ...draft, body: draft.body.replace(NAME_PLACEHOLDER, firstName) };
}
