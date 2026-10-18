import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { maskPII } from "@/lib/mask";
import { computeBillChecks, LINE_ROLES, type BillLine, type BillChecks } from "@/lib/bill-checks";

export const maxDuration = 30;

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

type ConfirmPayload = {
  provider: string;
  bill_date: string;
  total: number;
  line_items: BillLine[];
};

type StoredLineItem = { label: string; amount: number };

type ApiResponse =
  | {
      success: true;
      bill: { id: string; provider: string; billDate: string; total: number; lineItems: (StoredLineItem & { role: BillLine["role"] })[] };
      checks: BillChecks;
      notice?: string;
    }
  | { success: false; reason: "bad_request" | "unauthorized" | "rate_limited" | "server_error"; message: string };

function json(body: ApiResponse, status: number) {
  return NextResponse.json(body, { status });
}

// Stores what the user confirmed on the review screen -- "This matches my
// paper bill". Re-validates and re-computes everything server-side (the
// client's live preview is never trusted as the final answer), masks text
// right at this storage boundary, then writes to the DB and the private
// bucket. Nothing before this point is stored.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return json({ success: false, reason: "unauthorized", message: "Please sign in first." }, 401);
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const dataRaw = form?.get("data");

  if (!form || !(file instanceof File) || typeof dataRaw !== "string") {
    return json({ success: false, reason: "bad_request", message: "Missing file or bill data." }, 400);
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return json({ success: false, reason: "bad_request", message: "That file is too large (max 20MB)." }, 400);
  }
  const isPdf = file.type === "application/pdf";
  const isImage = file.type.startsWith("image/");
  if (!isPdf && !isImage) {
    return json({ success: false, reason: "bad_request", message: "Please upload an image (PNG/JPEG) or a PDF." }, 400);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(dataRaw);
  } catch {
    return json({ success: false, reason: "bad_request", message: "Bill data wasn't valid JSON." }, 400);
  }

  const validated = validatePayload(parsed);
  if (!validated.ok) {
    return json({ success: false, reason: "bad_request", message: validated.message }, 400);
  }
  const { provider, bill_date, total, line_items } = validated.data;

  const checks = computeBillChecks(line_items, total);

  const maskedProvider = maskPII(provider);
  // Payment-role lines are stored with the literal label "Amount Paid"
  // (docs/schema.md), so a later feature can identify them by that
  // convention alone -- there's no role column to persist.
  const maskedLineItems: StoredLineItem[] = line_items.map((li) => ({
    label: li.role === "payment" ? "Amount Paid" : maskPII(li.label),
    amount: li.amount,
  }));

  const bytes = Buffer.from(await file.arrayBuffer());
  const ext = isPdf ? "pdf" : file.type.split("/")[1] || "bin";
  const path = `${user.id}/${crypto.randomUUID()}.${ext}`;

  const { error: uploadError } = await supabase.storage.from("bills").upload(path, bytes, {
    contentType: file.type,
    upsert: false,
  });
  if (uploadError) {
    console.error("Storage upload failed:", uploadError);
    return json({ success: false, reason: "server_error", message: "Couldn't save the file. Please try again." }, 500);
  }

  const { data: bill, error: billError } = await supabase
    .from("bills")
    .insert({
      user_id: user.id,
      provider_name: maskedProvider,
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
    }))
  );

  if (lineItemsError) {
    console.error("Line items insert failed:", lineItemsError);
    return json(
      { success: false, reason: "server_error", message: "Couldn't save this bill's line items. Please try again." },
      500
    );
  }

  return json(
    {
      success: true,
      bill: {
        id: bill.id,
        provider: maskedProvider,
        billDate: bill_date,
        total,
        lineItems: maskedLineItems.map((li, i) => ({ ...li, role: line_items[i].role })),
      },
      checks,
    },
    200
  );
}

function validatePayload(value: unknown): { ok: true; data: ConfirmPayload } | { ok: false; message: string } {
  if (typeof value !== "object" || value === null) {
    return { ok: false, message: "Bill data was missing." };
  }
  const v = value as Record<string, unknown>;

  const provider = typeof v.provider === "string" ? v.provider.trim() : "";
  if (!provider) return { ok: false, message: "Please enter the provider name." };

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
    line_items.push({ label, amount, role });
  }

  return { ok: true, data: { provider, bill_date, total, line_items } };
}
