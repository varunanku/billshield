import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { maskPII } from "@/lib/mask";
import { isValidOwnedPath } from "@/lib/storage-paths";
import { computeBillChecks, toPersistedLines, LINE_ROLES, type BillLine, type BillChecks, type PersistedLine } from "@/lib/bill-checks";
import { decideVerdict, type Verdict } from "@/lib/verdict";

export const maxDuration = 30;

type PromiseInput = { statement: string; promisedAmount: number | null } | null;

type ConfirmPayload = {
  path: string;
  provider: string;
  provider_legal_name: string | null;
  bill_date: string;
  total: number;
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
  const { path, provider, provider_legal_name, bill_date, total, line_items, promise } = validated.data;

  // bills.file_path is about to be set to this path -- it must be this
  // user's own upload, not one they typed in pointing at someone else's
  // file. user.id comes from the session above, never from the request body.
  if (!isValidOwnedPath(path, user.id)) {
    return json({ success: false, reason: "unauthorized", message: "That file doesn't belong to you." }, 401);
  }

  const checks = computeBillChecks(line_items, total);
  const verdict = decideVerdict({ lines: line_items, total, provider, billDate: bill_date, checks, promise });

  const maskedProvider = maskPII(provider);
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
      provider_name: maskedProvider,
      provider_legal_name: maskedProviderLegalName,
      bill_date,
      total_amount: total,
      file_path: path,
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
        provider: maskedProvider,
        providerLegalName: maskedProviderLegalName,
        billDate: bill_date,
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

  const provider = typeof v.provider === "string" ? v.provider.trim() : "";
  if (!provider) return { ok: false, message: "Please enter the provider name." };

  const providerLegalNameRaw = typeof v.provider_legal_name === "string" ? v.provider_legal_name.trim() : "";
  const provider_legal_name = providerLegalNameRaw || null;

  const bill_date = typeof v.bill_date === "string" ? v.bill_date : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bill_date)) {
    return { ok: false, message: "Please enter a valid bill date." };
  }

  const total = typeof v.total === "number" && Number.isFinite(v.total) ? v.total : null;
  if (total === null) return { ok: false, message: "Please enter the bill total." };

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

  return { ok: true, data: { path, provider, provider_legal_name, bill_date, total, line_items, promise } };
}
