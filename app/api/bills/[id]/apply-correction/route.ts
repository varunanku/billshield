import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { maskPII } from "@/lib/mask";
import {
  computeBillChecks,
  fromPersistedLines,
  type BillChecks,
  type LineRole,
  type PersistedLine,
} from "@/lib/bill-checks";
import { decideVerdict, type Verdict } from "@/lib/verdict";
import { applyCorrection, type Correction } from "@/lib/followup";
import { applyCorrectionSchema, idSchema, parseInput } from "@/lib/schemas";

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

    if (!idSchema.safeParse(billId).success) {
      return json({ success: false, reason: "bad_request", message: "That link isn't valid. Start over from the home page." }, 400);
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
      return json({ success: false, reason: "unauthorized", message: "That bill isn't in your account. Open one of your own bills from My bills." }, 401);
    }

    const { data: lineRows, error: lineError } = await supabase
      .from("line_items")
      .select("id, line_order, label, amount, role, flagged")
      .eq("bill_id", billId)
      .order("line_order", { ascending: true });
    if (lineError || !lineRows) {
      return json({ success: false, reason: "server_error", message: "Couldn't load this bill's lines. Please try again in a moment." }, 500);
    }
    if (correction.field === "line" && lineRows.some((r) => r.role === null)) {
      return json(
        {
          success: false,
          reason: "bad_request",
          message: "This older bill can't be corrected here. Upload it again to fix that line.",
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
      return json({ success: false, reason: "bad_request", message: "That line isn't on this bill any more. Ask about a line you can see." }, 400);
    }

    // "Unknown provider" is confirm's storage-only placeholder for bills.
    // provider_name's NOT NULL column (see app/api/bills/confirm/route.ts) --
    // never shown to a user, so it's translated back to "your provider" the
    // same way here, before it reaches the verdict/email/display layer.
    const rawProvider = bill.provider_name === "Unknown provider" ? "your provider" : bill.provider_name;
    const before = { provider: rawProvider, billDate: bill.bill_date, total: Number(bill.total_amount), lines };
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

    // Same best-effort reconciled total as confirm (monthly timeline, 0015).
    const { error: reconciledError } = await supabase
      .from("bills")
      .update({ reconciled_total: checks.effectiveTotal })
      .eq("id", billId);
    if (reconciledError) console.error("Reconciled total update failed:", reconciledError.message);

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
  return parseInput(applyCorrectionSchema, value);
}
