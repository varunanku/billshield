// Pure prompt-building for the post-verdict follow-up chat. No network, so
// it's testable directly -- the actual LLM call lives in groq.ts/gemini.ts
// (answerFollowupQuestion), same as extraction's provider split.
import type { LineRole } from "./bill-checks.ts";

export type FollowupBillContext = {
  provider: string | null;
  billDate: string | null;
  total: number;
  lineItems: { label: string; amount: number; role: LineRole }[];
  verdictOutcome: "clean" | "confirmed_error" | "cannot_verify" | "unexplained";
  verdictGap: number | null;
  disputedLines: { label: string; amount: number }[];
  warnings: string[];
};

export type ChatTurn = { role: "user" | "assistant"; content: string };

export const MAX_FOLLOWUP_MESSAGES = 10;

export function buildFollowupSystemPrompt(context: FollowupBillContext): string {
  const lines =
    context.lineItems.length > 0
      ? context.lineItems.map((li) => `- ${li.label}: Rs ${li.amount.toFixed(2)} [${li.role}]`).join("\n")
      : "(none extracted)";
  const disputed =
    context.disputedLines.length > 0
      ? context.disputedLines.map((l) => `${l.label} (Rs ${l.amount.toFixed(2)})`).join(", ")
      : "none";
  const warnings = context.warnings.length > 0 ? context.warnings.join("\n") : "none";

  return `You answer a user's questions about ONE specific bill. Use ONLY the facts printed below -- never invent, total, or recompute a number that isn't already given here.

Provider: ${context.provider ?? "unknown"}
Bill date: ${context.billDate ?? "unknown"}
Printed total: Rs ${context.total.toFixed(2)}
Line items:
${lines}

App's verdict on this bill: ${context.verdictOutcome}
Gap found (if any): ${context.verdictGap === null ? "none" : `Rs ${context.verdictGap.toFixed(2)}`}
Disputed/unexplained lines: ${disputed}
Other warnings the app noticed: ${warnings}

Rules:
- Answer only about this bill's contents and the app's own verdict/warnings above.
- Never state a number that isn't already printed above exactly as given -- don't add, subtract, or estimate.
- If the bill doesn't show something the user asks about, say so plainly rather than guessing.
- If asked whether a charge is legal or against policy, say the app can't confirm that, only the maths.
- Keep answers short and in plain language.`;
}
