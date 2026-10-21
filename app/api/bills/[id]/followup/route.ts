import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { LINE_ROLES, type LineRole } from "@/lib/bill-checks";
import {
  buildFollowupSystemPrompt,
  parseFollowupReply,
  buildHistoryResultTurn,
  MAX_FOLLOWUP_MESSAGES,
  type FollowupBillContext,
  type ChatTurn,
  type FollowupReply,
} from "@/lib/followup";
import { computeHistoryQuery } from "@/lib/history";
import { computeTaxBreakdown, findMatchingRate, buildTaxBreakdownAddendum } from "@/lib/gst";
import { answerFollowupQuestion as askGroq } from "@/lib/groq";
import { answerFollowupQuestion as askOpenRouter } from "@/lib/openrouter";
import { USE_GROQ } from "@/lib/provider";
import { answerWithRetry, followupErrorMessage } from "@/lib/followup-provider";

export const maxDuration = 45;

// OpenRouter is the default/primary provider (Groq the fallback, or the
// one retry of itself when it's already primary) -- see
// lib/followup-provider.ts#answerWithRetry for exactly what gets retried
// and when.
function answerFollowupQuestion(systemPrompt: string, history: ChatTurn[]) {
  const primary = USE_GROQ ? askGroq : askOpenRouter;
  return answerWithRetry(systemPrompt, history, primary, askGroq);
}

type ApiResponse =
  | { success: true; reply: FollowupReply; messagesUsed: number }
  | { success: false; reason: "bad_request" | "unauthorized" | "rate_limited" | "server_error"; message: string };

function json(body: ApiResponse, status: number) {
  return NextResponse.json(body, { status });
}

// Dev-only detail appended to an otherwise-generic error message -- never
// in production (hard rule: don't leak internals to end users), but this
// route's first live run failed with no visible cause anywhere, so every
// server_error below now says exactly why outside production.
const isDev = process.env.NODE_ENV !== "production";
function withDevDetail(message: string, detail: unknown): string {
  return isDev ? `${message} [dev: ${String(detail)}]` : message;
}

// The bill context (provider, line items with roles, verdict, warnings)
// was already fully computed server-side at /api/bills/confirm time and
// has lived in the client's state since -- same round-trip pattern as
// /api/bills/draft-email's `facts`. The LLM only explains; it never
// computes a number, so trusting the client's own facts about their own
// bill here carries the same risk as that existing route, not a new one.
export async function POST(request: Request, routeContext: { params: Promise<{ id: string }> }) {
  try {
    const { id: billId } = await routeContext.params;
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return json({ success: false, reason: "unauthorized", message: "Please sign in first." }, 401);
    }

    const parsed = await request.json().catch(() => null);
    const validated = validatePayload(parsed);
    if (!validated.ok) {
      return json({ success: false, reason: "bad_request", message: validated.message }, 400);
    }
    const { question, context } = validated.data;

    // RLS-scoped: this also confirms the bill belongs to the signed-in user.
    const { data: bill, error: billError } = await supabase.from("bills").select("id, category").eq("id", billId).single();
    if (billError || !bill) {
      return json({ success: false, reason: "unauthorized", message: "That bill doesn't belong to you." }, 401);
    }

    const { data: priorRows, error: historyError } = await supabase
      .from("messages")
      .select("role, body, final_body")
      .eq("bill_id", billId)
      .eq("type", "followup")
      .order("created_at", { ascending: true });
    if (historyError) {
      // The most common cause here: migrations 0003/0004 haven't been run
      // yet against this Supabase project, so `type`/`role` don't exist on
      // messages -- this is the one place that failure first surfaces.
      console.error("Follow-up history fetch failed:", historyError);
      return json(
        { success: false, reason: "server_error", message: withDevDetail("Something went wrong. Please try again.", historyError.message) },
        500
      );
    }

    const userTurnsUsed = (priorRows ?? []).filter((r) => r.role === "user").length;
    if (userTurnsUsed >= MAX_FOLLOWUP_MESSAGES) {
      return json(
        { success: false, reason: "rate_limited", message: `You've reached the ${MAX_FOLLOWUP_MESSAGES}-question limit for this bill.` },
        429
      );
    }

    const history: ChatTurn[] = (priorRows ?? []).map((r) => ({
      role: r.role === "assistant" ? "assistant" : "user",
      content: (r.final_body ?? r.body) as string,
    }));
    history.push({ role: "user", content: question });

    // Tax breakdown (Phase 4): each tax line classified (CGST+SGST pair,
    // IGST, foreign VAT, electricity duty, ...) and its effective rate
    // computed in code, compared against any matching seeded reference
    // rate -- never the model's own say-so on what the rate should be.
    // The comparison itself only ever fires when the bill printed an
    // HSN/SAC code that matches a seeded hsn_prefix (see
    // lib/gst.ts#findMatchingRate) -- context.printedHsnCodes is exactly
    // (and only) those printed codes, carried client-side from extraction.
    const lineItems = context.lineItems.map((li) => ({ label: li.label, amount: li.amount, role: li.role }));
    let gstAddendum = "";
    const hasTaxLines = lineItems.some((li) => li.role === "tax");
    if (hasTaxLines) {
      const { data: rateRows } = await supabase.from("category_rates").select("*").eq("category", bill.category ?? "");
      const breakdown = computeTaxBreakdown(lineItems, bill.category, rateRows ?? [], context.printedHsnCodes);
      const matchingRate = findMatchingRate(rateRows ?? [], bill.category, context.printedHsnCodes);
      gstAddendum = buildTaxBreakdownAddendum(breakdown, matchingRate);
    }

    const systemPrompt = buildFollowupSystemPrompt(context) + gstAddendum;
    const result = await answerFollowupQuestion(systemPrompt, history);

    if (!result.ok) {
      // detail is always a provider-side technical string (an HTTP status
      // body, "network error: ...", or "no content in X response") --
      // never the bill content/question/systemPrompt, so this is already
      // safe to log as-is (no bill content or PII in it).
      console.error("Follow-up answer failed:", result.kind === "failed" ? result.detail : "rate_limited (after retry)");
      const { reason, message } = followupErrorMessage(result);
      return json(
        { success: false, reason, message: reason === "server_error" ? withDevDetail(message, result.kind === "failed" ? result.detail : "") : message },
        reason === "rate_limited" ? 429 : 500
      );
    }

    let reply = parseFollowupReply(result.text);

    // A get_history request never reaches the client -- it's resolved
    // right here, in one more round-trip, before this turn is considered
    // answered. The query is scoped to `bills`/`bill_metrics` through the
    // same RLS-enforcing client as everything else in this route, so it
    // can only ever see this signed-in user's own bills (hard rule 4).
    if (reply.type === "get_history") {
      const { provider, metric, months } = reply.request;
      const { data: matchingBills } = await supabase
        .from("bills")
        .select("id, bill_date, total_amount")
        .ilike("provider_name", `%${provider}%`)
        .order("bill_date", { ascending: false })
        .limit(months);

      let values: { billDate: string; value: number }[] = [];
      if (metric === "total") {
        values = (matchingBills ?? []).map((b) => ({ billDate: b.bill_date, value: Number(b.total_amount) }));
      } else if (matchingBills && matchingBills.length > 0) {
        const { data: metricRows } = await supabase
          .from("bill_metrics")
          .select("bill_id, value")
          .eq("metric", "units_consumed")
          .in(
            "bill_id",
            matchingBills.map((b) => b.id)
          );
        const byBillId = new Map((metricRows ?? []).map((m) => [m.bill_id, Number(m.value)]));
        values = matchingBills.filter((b) => byBillId.has(b.id)).map((b) => ({ billDate: b.bill_date, value: byBillId.get(b.id)! }));
      }

      const historyResult = computeHistoryQuery(values);
      const followupTurn = buildHistoryResultTurn(reply.request, historyResult);
      const secondResult = await answerFollowupQuestion(systemPrompt, [...history, { role: "assistant", content: result.text }, followupTurn]);
      reply = secondResult.ok ? parseFollowupReply(secondResult.text) : { type: "answer", text: "Couldn't look up that history just now. Please try again." };
      // However the model phrased it, this turn is answering the user's
      // ORIGINAL question -- a nested get_history/correction here would
      // just be confusing, so anything but a plain answer falls back to
      // its raw text rather than recursing further.
      if (reply.type !== "answer") reply = { type: "answer", text: secondResult.ok ? secondResult.text : "Couldn't look up that history just now." };
    }

    // A correction proposal is stored as a readable summary, not the raw
    // JSON -- it's what later history-building re-feeds the model as this
    // turn's content, and it's what a human would see if they ever read
    // the messages table directly.
    const assistantBody =
      reply.type === "answer"
        ? reply.text
        : `Proposed correction: ${reply.correction.field}${
            reply.correction.line_index !== null ? ` #${reply.correction.line_index}` : ""
          } -> ${reply.correction.new_label ?? reply.correction.new_amount ?? reply.correction.new_role ?? "?"} (${reply.correction.reason})`;

    const { error: insertError } = await supabase.from("messages").insert([
      { bill_id: billId, type: "followup", role: "user", body: question },
      { bill_id: billId, type: "followup", role: "assistant", body: assistantBody },
    ]);
    if (insertError) {
      console.error("Follow-up message insert failed:", insertError);
      return json(
        { success: false, reason: "server_error", message: withDevDetail("Couldn't save that. Please try again.", insertError.message) },
        500
      );
    }

    return json({ success: true, reply, messagesUsed: userTurnsUsed + 1 }, 200);
  } catch (err) {
    // Catches anything the specific checks above didn't anticipate (a bad
    // env var, a malformed response, etc.) so the client always gets a
    // clean JSON error instead of a generic framework 500 with no detail.
    console.error("Follow-up route crashed:", err);
    return json({ success: false, reason: "server_error", message: withDevDetail("Something went wrong. Please try again.", err) }, 500);
  }
}

function validatePayload(
  value: unknown
): { ok: true; data: { question: string; context: FollowupBillContext } } | { ok: false; message: string } {
  if (typeof value !== "object" || value === null) return { ok: false, message: "Request body was missing." };
  const v = value as Record<string, unknown>;

  const question = typeof v.question === "string" ? v.question.trim() : "";
  if (!question) return { ok: false, message: "No question was given." };
  if (question.length > 1000) return { ok: false, message: "That question is too long." };

  if (typeof v.context !== "object" || v.context === null) return { ok: false, message: "Missing bill context." };
  const c = v.context as Record<string, unknown>;

  const provider = typeof c.provider === "string" ? c.provider : null;
  const billDate = typeof c.billDate === "string" ? c.billDate : null;
  const total = typeof c.total === "number" && Number.isFinite(c.total) ? c.total : null;
  if (total === null) return { ok: false, message: "Bill context was incomplete." };

  const VERDICT_OUTCOMES = ["clean", "confirmed_error", "cannot_verify", "unexplained"];
  const verdictOutcome = VERDICT_OUTCOMES.includes(c.verdictOutcome as string)
    ? (c.verdictOutcome as FollowupBillContext["verdictOutcome"])
    : null;
  if (!verdictOutcome) return { ok: false, message: "Bill context was incomplete." };

  const verdictGap =
    typeof c.verdictGap === "number" && Number.isFinite(c.verdictGap) ? c.verdictGap : null;

  const lineItems: { label: string; amount: number; role: LineRole }[] = [];
  if (Array.isArray(c.lineItems)) {
    for (const raw of c.lineItems) {
      if (typeof raw !== "object" || raw === null) continue;
      const li = raw as Record<string, unknown>;
      if (
        typeof li.label === "string" &&
        typeof li.amount === "number" &&
        Number.isFinite(li.amount) &&
        LINE_ROLES.includes(li.role as LineRole)
      ) {
        lineItems.push({ label: li.label, amount: li.amount, role: li.role as LineRole });
      }
    }
  }

  const disputedLines: { label: string; amount: number }[] = [];
  if (Array.isArray(c.disputedLines)) {
    for (const raw of c.disputedLines) {
      if (typeof raw !== "object" || raw === null) continue;
      const line = raw as Record<string, unknown>;
      if (typeof line.label === "string" && typeof line.amount === "number" && Number.isFinite(line.amount)) {
        disputedLines.push({ label: line.label, amount: line.amount });
      }
    }
  }

  const warnings = Array.isArray(c.warnings) ? c.warnings.filter((w): w is string => typeof w === "string") : [];
  const printedHsnCodes = Array.isArray(c.printedHsnCodes)
    ? c.printedHsnCodes.filter((code): code is string => typeof code === "string")
    : [];
  const taxTotal = typeof c.taxTotal === "number" && Number.isFinite(c.taxTotal) ? c.taxTotal : 0;

  let expectedAmount: FollowupBillContext["expectedAmount"] = null;
  if (typeof c.expectedAmount === "object" && c.expectedAmount !== null) {
    const ea = c.expectedAmount as Record<string, unknown>;
    if (typeof ea.promisedAmount === "number" && Number.isFinite(ea.promisedAmount)) {
      expectedAmount = {
        promisedAmount: ea.promisedAmount,
        matchedLineLabel: typeof ea.matchedLineLabel === "string" ? ea.matchedLineLabel : null,
      };
    }
  }

  return {
    ok: true,
    data: {
      question,
      context: { provider, billDate, total, lineItems, verdictOutcome, verdictGap, disputedLines, warnings, printedHsnCodes, taxTotal, expectedAmount },
    },
  };
}
