import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { maskPII } from "@/lib/mask";
import { isValidOwnedPath } from "@/lib/storage-paths";
import {
  computeBillChecks,
  toPersistedLines,
  LINE_ROLES,
  BILL_CATEGORIES,
  type BillLine,
  type BillCategory,
  type BillChecks,
  type PersistedLine,
} from "@/lib/bill-checks";
import { decideVerdict, type Verdict } from "@/lib/verdict";
import { findTaxOvercharge } from "@/lib/gst";

export const maxDuration = 30;

type PromiseInput = { statement: string; promisedAmount: number | null } | null;

type ConfirmPayload = {
  path: string;
  provider: string;
  provider_legal_name: string | null;
  bill_date: string;
  total: number;
  category: BillCategory | null;
  billing_period_start: string | null;
  billing_period_end: string | null;
  units_consumed: number | null;
  units_consumed_unit: string | null;
  // Not persisted (no bills column for this, and none is needed past this
  // one-time computation) -- only ever used right here to feed the tax-
  // overcharge check below. See lib/gst.ts#findMatchingRate: a category
  // alone is never enough, this is the one thing that makes a comparison
  // possible at all.
  printed_hsn_codes: string[];
  line_items: BillLine[];
  promise: PromiseInput;
};

type ApiResponse =
  | {
      success: true;
      bill: {
        id: string;
        provider: string;
        providerLegalName: string | null;
        billDate: string;
        total: number;
        lineItems: PersistedLine[];
      };
      checks: BillChecks;
      verdict: Verdict;
    }
  | { success: false; reason: "bad_request" | "unauthorized" | "server_error"; message: string };

function json(body: ApiResponse, status: number) {
  return NextResponse.json(body, { status });
}

// Stores what the user confirmed on the review screen -- "This matches my
// paper bill". The file itself is already in the bills bucket (uploaded
// directly by the browser before extraction); this route only re-validates
// and re-computes the bill data server-side (the client's live preview is
// never trusted as the final answer), masks text right at this storage
// boundary, then writes the DB rows. Nothing before this point touches the
// database.
//
// The verdict is also decided here, not in a later route: line_items has
// no role column, so this is the last point the full role-rich line list
// (charge/tax/discount/subtotal/payment/...) exists anywhere -- once
// toPersistedLines runs, balance/subtotal/info/opening rows are gone for
// good. A later "decide the verdict" step reading line_items back
// couldn't reconstruct the checkpoints this needs.
export async function POST(request: Request) {
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
  const {
    path,
    provider,
    provider_legal_name,
    bill_date,
    total,
    category,
    billing_period_start,
    billing_period_end,
    units_consumed,
    units_consumed_unit,
    printed_hsn_codes,
    line_items,
    promise,
  } = validated.data;

  // bills.file_path is about to be set to this path -- it must be this
  // user's own upload, not one they typed in pointing at someone else's
  // file. user.id comes from the session above, never from the request body.
  if (!isValidOwnedPath(path, user.id)) {
    return json({ success: false, reason: "unauthorized", message: "That file doesn't belong to you." }, 401);
  }

  // Neither is required on the review screen. "your provider"/today's date
  // are what the user, My bills and the drafted email see; bills.provider_
  // name and bill_date are NOT NULL columns (supabase/migrations/0001_init.sql),
  // so a missing provider is stored as the distinct sentinel "Unknown
  // provider" instead (never shown to a user -- see app/bills/page.tsx),
  // and a missing date is stored as the day it was confirmed, since there's
  // no printed one to fall back on.
  const displayProvider = provider ? maskPII(provider) : "your provider";
  const storedProvider = provider ? displayProvider : "Unknown provider";
  const storedBillDate = bill_date || new Date().toISOString().slice(0, 10);

  const checks = computeBillChecks(line_items, total);

  // Tax overcharge finding (Phase 3): only ever non-null when the bill
  // printed an HSN/SAC code that matches a seeded reference rate for its
  // own category AND the billed rate is confirmed higher than that
  // reference -- see lib/gst.ts for the full chain. category can be null
  // (findTaxOvercharge/findMatchingRate already treat null/"other" as
  // "no comparison possible", so this never needs its own branch here).
  const { data: rateRows } = category
    ? await supabase.from("category_rates").select("*").eq("category", category)
    : { data: [] };
  const taxFinding = findTaxOvercharge(line_items, category, rateRows ?? [], printed_hsn_codes);

  const verdict = decideVerdict({
    lines: line_items,
    total,
    provider: displayProvider,
    billDate: storedBillDate,
    checks,
    promise,
    taxFinding,
  });

  const maskedProviderLegalName = provider_legal_name ? maskPII(provider_legal_name) : null;
  // toPersistedLines decides which rows exist and their amount sign/label
  // convention (see lib/bill-checks.ts); masking the label text is still
  // this route's job, skipped for the literal "Amount Paid" relabel.
  const maskedLineItems: PersistedLine[] = toPersistedLines(line_items).map((li) => ({
    ...li,
    label: li.role === "payment" ? li.label : maskPII(li.label),
  }));

  const { data: bill, error: billError } = await supabase
    .from("bills")
    .insert({
      user_id: user.id,
      provider_name: storedProvider,
      provider_legal_name: maskedProviderLegalName,
      bill_date: storedBillDate,
      total_amount: total,
      file_path: path,
      category,
      billing_period_start,
      billing_period_end,
      verdict_outcome: verdict.outcome,
      verdict_gap: "facts" in verdict ? verdict.facts.gap : null,
    })
    .select()
    .single();

  if (billError || !bill) {
    console.error("Bill insert failed:", billError);
    return json({ success: false, reason: "server_error", message: "Couldn't save this bill. Please try again." }, 500);
  }

  const { error: lineItemsError } = await supabase.from("line_items").insert(
    maskedLineItems.map((li, index) => ({
      bill_id: bill.id,
      line_order: index + 1,
      label: li.label,
      amount: li.amount,
      role: li.role,
      flagged: li.unrecognized,
    }))
  );

  if (lineItemsError) {
    console.error("Line items insert failed:", lineItemsError);
    return json(
      { success: false, reason: "server_error", message: "Couldn't save this bill's line items. Please try again." },
      500
    );
  }

  if (units_consumed !== null) {
    const { error: metricError } = await supabase.from("bill_metrics").insert({
      bill_id: bill.id,
      metric: "units_consumed",
      value: units_consumed,
      unit: units_consumed_unit,
    });
    // Same as the promise below -- a metric is supplementary, never worth
    // failing the whole confirm over.
    if (metricError) console.error("Bill metric insert failed:", metricError);
  }

  if (promise) {
    const { error: promiseError } = await supabase.from("promises").insert({
      bill_id: bill.id,
      statement: maskPII(promise.statement),
      promised_amount: promise.promisedAmount,
    });
    // A promise is optional context, not required for the bill itself to be
    // saved -- log and continue rather than failing the whole confirm.
    if (promiseError) console.error("Promise insert failed:", promiseError);
  }

  return json(
    {
      success: true,
      bill: {
        id: bill.id,
        provider: displayProvider,
        providerLegalName: maskedProviderLegalName,
        billDate: storedBillDate,
        total,
        lineItems: maskedLineItems,
      },
      checks,
      verdict,
    },
    200
  );
}

function validatePayload(value: unknown): { ok: true; data: ConfirmPayload } | { ok: false; message: string } {
  if (typeof value !== "object" || value === null) {
    return { ok: false, message: "Bill data was missing." };
  }
  const v = value as Record<string, unknown>;

  const path = typeof v.path === "string" ? v.path : "";
  if (!path) return { ok: false, message: "No uploaded file path was given." };

  // Both optional -- a bill with no printed provider name or date can still
  // be confirmed (see computeConfirm below for how a missing one is stored
  // and displayed).
  const provider = typeof v.provider === "string" ? v.provider.trim() : "";

  const providerLegalNameRaw = typeof v.provider_legal_name === "string" ? v.provider_legal_name.trim() : "";
  const provider_legal_name = providerLegalNameRaw || null;

  const bill_date = typeof v.bill_date === "string" ? v.bill_date.trim() : "";
  if (bill_date && !/^\d{4}-\d{2}-\d{2}$/.test(bill_date)) {
    return { ok: false, message: "Please enter a valid bill date." };
  }

  const total = typeof v.total === "number" && Number.isFinite(v.total) ? v.total : null;
  if (total === null) return { ok: false, message: "Please enter the bill total." };

  const category = BILL_CATEGORIES.includes(v.category as BillCategory) ? (v.category as BillCategory) : null;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const billing_period_start = typeof v.billing_period_start === "string" && DATE_RE.test(v.billing_period_start) ? v.billing_period_start : null;
  const billing_period_end = typeof v.billing_period_end === "string" && DATE_RE.test(v.billing_period_end) ? v.billing_period_end : null;
  const units_consumed = typeof v.units_consumed === "number" && Number.isFinite(v.units_consumed) ? v.units_consumed : null;
  const units_consumed_unit = typeof v.units_consumed_unit === "string" ? v.units_consumed_unit : null;
  const printed_hsn_codes = Array.isArray(v.printed_hsn_codes)
    ? v.printed_hsn_codes.filter((c): c is string => typeof c === "string")
    : [];

  if (!Array.isArray(v.line_items) || v.line_items.length === 0) {
    return { ok: false, message: "At least one line item is required." };
  }

  const line_items: BillLine[] = [];
  for (const raw of v.line_items) {
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, message: "A line item was malformed." };
    }
    const item = raw as Record<string, unknown>;
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const amount = typeof item.amount === "number" && Number.isFinite(item.amount) ? item.amount : null;
    const role = LINE_ROLES.includes(item.role as BillLine["role"]) ? (item.role as BillLine["role"]) : null;
    if (!label || amount === null || !role) {
      return { ok: false, message: "Every line needs a label, amount and role." };
    }
    line_items.push({ label, amount, role, unrecognized: item.unrecognized === true });
  }

  let promise: PromiseInput = null;
  if (typeof v.promise === "object" && v.promise !== null) {
    const p = v.promise as Record<string, unknown>;
    const statement = typeof p.statement === "string" ? p.statement.trim() : "";
    if (statement) {
      const promisedAmount =
        typeof p.promisedAmount === "number" && Number.isFinite(p.promisedAmount) ? p.promisedAmount : null;
      promise = { statement, promisedAmount };
    }
  }

  return {
    ok: true,
    data: {
      path,
      provider,
      provider_legal_name,
      bill_date,
      total,
      category,
      billing_period_start,
      billing_period_end,
      units_consumed,
      units_consumed_unit,
      printed_hsn_codes,
      line_items,
      promise,
    },
  };
}
