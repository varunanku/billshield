// Pure prompt-building and reply-parsing for the post-verdict follow-up
// chat. No network, so it's testable directly -- the actual LLM call
// lives in groq.ts/openrouter.ts (answerFollowupQuestion), same as
// extraction's provider split.
import { LINE_ROLES, type BillLine, type LineRole } from "./bill-checks.ts";

export type FollowupBillContext = {
  provider: string | null;
  billDate: string | null;
  total: number;
  lineItems: { label: string; amount: number; role: LineRole }[];
  verdictOutcome: "clean" | "confirmed_error" | "cannot_verify" | "unexplained";
  verdictGap: number | null;
  disputedLines: { label: string; amount: number }[];
  warnings: string[];
  printedHsnCodes: string[]; // only codes the bill itself printed -- see lib/gst.ts#findMatchingRate
  taxTotal: number; // sum of tax-role lines, computed in code (app/page.tsx#buildFollowupContext)
  // Set only when the verdict's gap is printed total minus the amount the
  // user expected (lib/verdict.ts, reason "promise_mismatch") -- verdictGap
  // is then that gap, not an arithmetic/payment one.
  expectedAmount?: { promisedAmount: number; matchedLineLabel: string | null } | null;
};

export type ChatTurn = { role: "user" | "assistant"; content: string };

export const MAX_FOLLOWUP_MESSAGES = 10;

// The overpaid reason (lib/verdict.ts) has no disputedLines of its own --
// bill-checks.ts's payment check isn't about any one line -- but it DOES
// have a matched reconciling line (e.g. "OUTSTANDING_AMOUNT") when one
// exists, and the chat should be able to name it just as specifically as
// any other confirmed_error. Never overrides an outcome that already has
// its own disputedLines (checkpoint/promise/unrecognized-line).
export function disputedLinesForChat(facts: {
  disputedLines: { label: string; amount: number }[];
  reconcilingBalanceLabel: string | null;
  gap: number;
} | null): { label: string; amount: number }[] {
  if (!facts) return [];
  if (facts.disputedLines.length > 0) return facts.disputedLines;
  if (facts.reconcilingBalanceLabel) return [{ label: facts.reconcilingBalanceLabel, amount: Math.abs(facts.gap) }];
  return [];
}

export function buildFollowupSystemPrompt(context: FollowupBillContext): string {
  const lines =
    context.lineItems.length > 0
      ? context.lineItems.map((li, i) => `${i}: ${li.label} -- Rs ${li.amount.toFixed(2)} [${li.role}]`).join("\n")
      : "(none extracted)";
  const disputed =
    context.disputedLines.length > 0
      ? context.disputedLines.map((l) => `${l.label} (Rs ${l.amount.toFixed(2)})`).join(", ")
      : "none";
  const warnings = context.warnings.length > 0 ? context.warnings.join("\n") : "none";
  // The sign convention (gap = billedSum - amountPaid, negative = overpaid)
  // is an internal implementation detail of lib/verdict.ts -- never handed
  // to the model as a bare signed number it might just parrot back. Spelled
  // out here instead, in the one direction a user actually cares about.
  const gapDescription =
    context.verdictGap === null
      ? "none"
      : context.expectedAmount
        ? `Rs ${Math.abs(context.verdictGap).toFixed(2)} -- the printed total is this much ${context.verdictGap >= 0 ? "higher" : "lower"} than the Rs ${context.expectedAmount.promisedAmount.toFixed(2)} the user expected to pay. This is NOT a confirmed billing error -- describe it as "${context.verdictGap >= 0 ? "higher" : "lower"} than the amount you expected", never as an error or overcharge.${
            context.expectedAmount.matchedLineLabel
              ? ` It matches the "${context.expectedAmount.matchedLineLabel}" line on the bill -- name that line when asked what explains the difference.`
              : ""
          }`
      : context.verdictGap < 0
        ? `Rs ${Math.abs(context.verdictGap).toFixed(2)} -- the user OVERPAID by this amount. Always describe this as "overpaid by Rs ${Math.abs(context.verdictGap).toFixed(2)}", never state a negative number.`
        : `Rs ${context.verdictGap.toFixed(2)} owed/undercharged by this amount.`;

  return `You answer a user's questions about ONE specific bill, and may propose a correction if you spot a misread. Use ONLY the facts printed below -- never invent, total, or recompute a number that isn't already given here.

Provider: ${context.provider ?? "unknown"}
Bill date: ${context.billDate ?? "unknown"}
Printed total: Rs ${context.total.toFixed(2)}
Line items (index: label -- amount [role]):
${lines}

BillShield's checks on this bill -- verdict: ${context.verdictOutcome}
Gap found (if any): ${gapDescription}
Disputed/unexplained lines (the ones BillShield's checks actually matched -- never substitute a different line from the list above): ${disputed}
Total tax (sum of this bill's tax lines, computed by BillShield's checks): Rs ${context.taxTotal.toFixed(2)}
Other warnings BillShield's checks noticed: ${warnings}

Rules:
- You are BillShield's AI assistant. Refer to code-computed results (sums, the tax comparison, the verdict) as
  "BillShield's checks", never as "the app".
- Answer only about this bill's contents and BillShield's checks (the verdict and warnings) above.
- Never state a number that isn't already printed above exactly as given -- don't add, subtract, or estimate.
- When asked which line explains a confirmed_error or cannot_verify outcome, name exactly the line(s) listed in
  "Disputed/unexplained lines" above -- never guess a different line from the full line-items list.
- If the bill doesn't show something the user asks about, say so plainly rather than guessing -- e.g. say "the
  bill doesn't show a combined total", never "BillShield's checks did not print X" (checks compute from what's
  printed, they don't print anything themselves).
- If asked whether a charge is legal or against policy, say BillShield can't confirm that, only the maths.
- When unsure, say so plainly and point the user back to their own paper bill -- never present an answer as
  certain if it isn't in the confirmed facts above.
- Keep answers short and in plain language.
- You NEVER compute or state a new total, verdict, or difference yourself -- a correction only ever proposes what
  a single field should read as, and code recomputes everything else after the user approves it.
- For tax rate questions, state the computed effective rate from the bill's actual tax lines (see the tax
  breakdown below, when present). Only ever mention an expected/reference rate, a mismatch, or an overcharge if
  the tax breakdown below explicitly marks it CONFIRMED -- a category alone is a guess, never grounds for a
  comparison. Never say a bill was undercharged, never suggest the user should have paid more tax, and never
  state a rate difference that isn't in the confirmed facts below. If there's no confirmed finding, say so
  plainly (the rate is informational only, no confirmed reference exists) rather than guessing.

Return ONLY a single JSON object, no other text, in exactly one of these three shapes:

To answer normally:
{"type": "answer", "text": string}

To propose a correction (only when the user's message points out something that's actually wrong, e.g. a misread
label/amount/role, or the wrong provider/date/total -- never propose one just to acknowledge a question):
{"type": "correction", "field": "provider" | "bill_date" | "printed_total" | "line", "line_index": number or null (required, and must be one of the indices above, when field is "line"), "new_label": string or null, "new_role": one of ${JSON.stringify(LINE_ROLES)} or null, "new_amount": number or null, "reason": string (one short sentence explaining why)}
Only set the new_* fields relevant to what's changing; leave the rest null.

To ask the app to look up this user's OWN past bills before you answer (only when the question genuinely needs
history, e.g. "how does this compare to last few months" or "what's my average usage" -- never for anything
answerable from the single bill above):
{"type": "get_history", "provider": string (which provider's bills to look up -- usually this bill's own provider unless the user names a different one), "metric": "total" | "units_consumed", "months": number (how many of that provider's most recent bills to consider, typically 3-12)}
You will then be given the computed figures and asked to phrase the final answer from those alone -- you still never compute the comparison yourself.`;
}

export type Correction = {
  field: "provider" | "bill_date" | "printed_total" | "line";
  line_index: number | null;
  new_label: string | null;
  new_role: LineRole | null;
  new_amount: number | null;
  reason: string;
};

export type HistoryMetric = "total" | "units_consumed";
export type HistoryRequest = { provider: string; metric: HistoryMetric; months: number };

export type FollowupReply =
  | { type: "answer"; text: string }
  | { type: "correction"; correction: Correction }
  | { type: "get_history"; request: HistoryRequest };

// Lenient by design: a model that fails to follow the JSON-shape
// instruction still has its raw text shown as a plain answer, rather than
// the whole turn erroring out.
export function parseFollowupReply(raw: string): FollowupReply {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed?.type === "correction" && typeof parsed.field === "string") {
      const field = parsed.field;
      if (field === "provider" || field === "bill_date" || field === "printed_total" || field === "line") {
        return {
          type: "correction",
          correction: {
            field,
            line_index: typeof parsed.line_index === "number" ? parsed.line_index : null,
            new_label: typeof parsed.new_label === "string" ? parsed.new_label : null,
            new_role: LINE_ROLES.includes(parsed.new_role as LineRole) ? (parsed.new_role as LineRole) : null,
            new_amount: typeof parsed.new_amount === "number" && Number.isFinite(parsed.new_amount) ? parsed.new_amount : null,
            reason: typeof parsed.reason === "string" ? parsed.reason : "",
          },
        };
      }
    }
    if (parsed?.type === "get_history" && typeof parsed.provider === "string") {
      const metric = parsed.metric === "units_consumed" ? "units_consumed" : "total";
      const months = typeof parsed.months === "number" && parsed.months > 0 ? Math.min(Math.round(parsed.months), 24) : 6;
      return { type: "get_history", request: { provider: parsed.provider, metric, months } };
    }
    if (parsed?.type === "answer" && typeof parsed.text === "string") {
      return { type: "answer", text: parsed.text };
    }
  } catch {
    // Not JSON (or didn't match either shape) -- fall through below.
  }
  return { type: "answer", text: raw };
}

// The follow-up turn fed back to the model after the route has resolved a
// get_history request in code -- the model phrases the answer from these
// numbers alone, it never saw (and can't recompute) the underlying rows.
export function buildHistoryResultTurn(
  request: HistoryRequest,
  result: { count: number; averageBeforeLatest: number | null; latestValue: number | null; latestDate: string | null }
): ChatTurn {
  const unit = request.metric === "units_consumed" ? "" : "Rs ";
  const content =
    result.count === 0
      ? `No past bills found for "${request.provider}". Say so plainly -- don't estimate or guess a figure.`
      : `Computed from the user's own last ${result.count} bill(s) for "${request.provider}" (metric: ${request.metric}): ` +
        `most recent (${result.latestDate}) = ${unit}${result.latestValue}` +
        (result.averageBeforeLatest !== null ? `, average of the bills before that = ${unit}${result.averageBeforeLatest.toFixed(2)}` : ", no earlier bills to average") +
        `. Answer the user's original question using ONLY these numbers -- do not add, subtract, or estimate anything beyond what's given here. Respond in the same {"type": "answer", "text": string} JSON shape as before.`;
  return { role: "user", content };
}

export type BillState = { provider: string; billDate: string; total: number; lines: BillLine[] };

// Pure: applies one approved correction to the bill state code already
// holds, so the caller can immediately recompute checks/verdict from the
// result. Never reads or writes anything itself -- the route owns
// persistence. An out-of-range line_index, or a correction with no
// matching new_* value set, leaves the state unchanged rather than
// guessing or throwing.
export function applyCorrection(state: BillState, correction: Correction): BillState {
  if (correction.field === "provider") {
    return correction.new_label !== null ? { ...state, provider: correction.new_label } : state;
  }
  if (correction.field === "bill_date") {
    return correction.new_label !== null ? { ...state, billDate: correction.new_label } : state;
  }
  if (correction.field === "printed_total") {
    return correction.new_amount !== null ? { ...state, total: correction.new_amount } : state;
  }
  // field === "line"
  if (correction.line_index === null || correction.line_index < 0 || correction.line_index >= state.lines.length) {
    return state;
  }
  const lines = state.lines.map((line, i) =>
    i === correction.line_index
      ? {
          ...line,
          label: correction.new_label ?? line.label,
          role: correction.new_role ?? line.role,
          amount: correction.new_amount ?? line.amount,
        }
      : line
  );
  return { ...state, lines };
}
