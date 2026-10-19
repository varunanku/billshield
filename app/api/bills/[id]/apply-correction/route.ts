import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { maskPII } from "@/lib/mask";
import {
  computeBillChecks,
  fromPersistedLines,
  LINE_ROLES,
  type BillChecks,
  type LineRole,
  type PersistedLine,
} from "@/lib/bill-checks";
import { decideVerdict, type Verdict } from "@/lib/verdict";
import { applyCorrection, type Correction } from "@/lib/followup";

export const maxDuration = 30;

type ApiResponse =
  | {
      success: true;
      bill: { id: string; provider: string; providerLegalName: string | null; billDate: string; total: number; lineItems: PersistedLine[] };
      checks: BillChecks;
      verdict: Verdict;
    }
  | { success: false; reason: "bad_request" | "unauthorized" | "server_error"; message: string };

function json(body: ApiResponse, status: number) {
  return NextResponse.json(body, { status });
}

// A chat-proposed correction (lib/followup.ts's parseFollowupReply) that
// the user clicked "Apply" on. The model only ever proposed what a single
// field should read as -- every number from here on (checks, verdict) is
// recomputed by code alone, exactly as it was at confirm time, never
// trusted from the model's own say-so (hard rule 2).
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
    const { correction } = validated.data;

    // RLS-scoped: also confirms the bill belongs to the signed-in user.
    const { data: bill, error: billError } = await supabase
      .from("bills")
      .select("id, provider_name, provider_legal_name, bill_date, total_amount")
      .eq("id", billId)
      .single();
    if (billError || !bill) {
      return json({ success: false, reason: "unauthorized", message: "That bill doesn't belong to you." }, 401);
    }

    const { data: lineRows, error: lineError } = await supabase
      .from("line_items")
      .select("id, line_order, label, amount, role, flagged")
      .eq("bill_id", billId)
      .order("line_order", { ascending: true });
    if (lineError || !lineRows) {
      return json({ success: false, reason: "server_error", message: "Couldn't load this bill's line items." }, 500);
    }
    if (correction.field === "line" && lineRows.some((r) => r.role === null)) {
      return json(
        {
          success: false,
          reason: "bad_request",
          message: "This bill was saved before line roles were tracked, so a line correction can't be applied here.",
        },
        400
      );
    }

    const lines = fromPersistedLines(
      lineRows.map((r) => ({
        label: r.label,
        amount: r.amount,
        role: (r.role ?? "charge") as LineRole,
        unrecognized: r.flagged,
      }))
    );

    if (correction.field === "line" && (correction.line_index! < 0 || correction.line_index! >= lines.length)) {
      return json({ success: false, reason: "bad_request", message: "That line no longer exists on this bill." }, 400);
    }

    const before = { provider: bill.provider_name, billDate: bill.bill_date, total: Number(bill.total_amount), lines };
    const after = applyCorrection(before, correction);

    const { data: promiseRow } = await supabase
      .from("promises")
      .select("statement, promised_amount")
      .eq("bill_id", billId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const promise = promiseRow ? { statement: promiseRow.statement, promisedAmount: promiseRow.promised_amount } : null;

    const checks = computeBillChecks(after.lines, after.total);
    const verdict = decideVerdict({
      lines: after.lines,
      total: after.total,
      provider: after.provider,
      billDate: after.billDate,
      checks,
      promise,
    });

    // The verdict snapshot ("My bills") is stale the moment any correction
    // lands -- refreshed alongside whichever field actually changed below.
    const verdictSnapshot = { verdict_outcome: verdict.outcome, verdict_gap: "facts" in verdict ? verdict.facts.gap : null };

    // Persist exactly what changed -- never the whole bill, so an
    // unrelated field can't drift from what's actually stored.
    if (correction.field === "provider") {
      await supabase.from("bills").update({ provider_name: maskPII(after.provider), ...verdictSnapshot }).eq("id", billId);
    } else if (correction.field === "bill_date") {
      await supabase.from("bills").update({ bill_date: after.billDate, ...verdictSnapshot }).eq("id", billId);
    } else if (correction.field === "printed_total") {
      await supabase.from("bills").update({ total_amount: after.total, ...verdictSnapshot }).eq("id", billId);
    } else {
      const target = lineRows[correction.line_index!];
      const updatedLine = after.lines[correction.line_index!];
      // toPersistedLines' own sign/label convention (discount negated,
      // payment relabelled) applies here too -- this is the same storage
      // shape, just reached via one corrected field instead of a fresh confirm.
      await supabase
        .from("line_items")
        .update({
          label: updatedLine.role === "payment" ? "Amount Paid" : maskPII(updatedLine.label),
          amount: updatedLine.role === "discount" ? -updatedLine.amount : updatedLine.amount,
          role: updatedLine.role,
        })
        .eq("id", target.id);
      await supabase.from("bills").update(verdictSnapshot).eq("id", billId);
    }

    const persistedLines: PersistedLine[] = after.lines.map((l) => ({
      label: l.role === "payment" ? "Amount Paid" : l.label,
      amount: l.role === "discount" ? -l.amount : l.amount,
      role: l.role,
      unrecognized: l.unrecognized ?? false,
    }));

    return json(
      {
        success: true,
        bill: {
          id: billId,
          provider: after.provider,
          providerLegalName: bill.provider_legal_name,
          billDate: after.billDate,
          total: after.total,
          lineItems: persistedLines,
        },
        checks,
        verdict,
      },
      200
    );
  } catch (err) {
    console.error("Apply-correction route crashed:", err);
    return json({ success: false, reason: "server_error", message: "Couldn't apply that correction. Please try again." }, 500);
  }
}

function validatePayload(value: unknown): { ok: true; data: { correction: Correction } } | { ok: false; message: string } {
  if (typeof value !== "object" || value === null) return { ok: false, message: "Request body was missing." };
  const v = value as Record<string, unknown>;
  if (typeof v.correction !== "object" || v.correction === null) return { ok: false, message: "Missing correction." };
  const c = v.correction as Record<string, unknown>;

  const field = c.field;
  if (field !== "provider" && field !== "bill_date" && field !== "printed_total" && field !== "line") {
    return { ok: false, message: "Invalid correction field." };
  }
  const line_index = typeof c.line_index === "number" ? c.line_index : null;
  if (field === "line" && line_index === null) {
    return { ok: false, message: "A line correction needs a line_index." };
  }
  const new_label = typeof c.new_label === "string" ? c.new_label : null;
  const new_role = LINE_ROLES.includes(c.new_role as LineRole) ? (c.new_role as LineRole) : null;
  const new_amount = typeof c.new_amount === "number" && Number.isFinite(c.new_amount) ? c.new_amount : null;
  const reason = typeof c.reason === "string" ? c.reason : "";

  return { ok: true, data: { correction: { field, line_index, new_label, new_role, new_amount, reason } } };
}
