import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { draftEmail, applySignature, TONE_PRESETS, type Tone, type TonePreset } from "@/lib/email-draft";
import type { Facts } from "@/lib/verdict";

export const maxDuration = 30;

type ApiResponse =
  | { success: true; messageId: string; subject: string; body: string; isDefaultTone: boolean }
  | { success: false; reason: "bad_request" | "unauthorized" | "server_error"; message: string };

function json(body: ApiResponse, status: number) {
  return NextResponse.json(body, { status });
}

// Drafts the one dispute/inquiry email for a bill already confirmed (clean
// bills never call this -- there's nothing to draft). The verdict's
// outcome decides the tone server-side (confident/inquiry) -- a client-sent
// tone is never trusted, only the outcome is read from the request, and
// that only picks between the two fixed tones, nothing else.
//
// facts was already fully computed in code by /api/bills/confirm (the only
// place the full role-rich line list still exists -- line_items in storage
// has no role column). This route doesn't re-derive the verdict; it only
// turns already-decided facts into prose, then stores the result.
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
  const { billId, outcome, facts, tonePreset } = validated.data;
  // confirmed_error is the only confident-tone outcome -- cannot_verify and
  // unexplained both draft a soft inquiry (the wording differs between
  // them inside draftEmail, keyed off facts, not off outcome).
  const tone: Tone = outcome === "confirmed_error" ? "confident" : "inquiry";
  const isDefaultTone = tonePreset === null;

  // RLS-scoped: this also confirms the bill belongs to the signed-in user.
  const { data: bill, error: billError } = await supabase
    .from("bills")
    .select("id")
    .eq("id", billId)
    .single();
  if (billError || !bill) {
    return json({ success: false, reason: "unauthorized", message: "That bill doesn't belong to you." }, 401);
  }

  // Code, not the prompt -- the sign-off's "[Name]" placeholder is swapped
  // for the user's own full name (auth metadata, same source as the
  // header/thank-you toast) here, after the draft already exists, on
  // every draft including a Regenerate (both hit this same route). Left
  // as "[Name]" when there's no name to put there.
  const fullName = typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name.trim() : "";
  const draft = applySignature(await draftEmail(facts, tone, tonePreset), fullName || null);

  // Each Regenerate click is a new row (the proof chain keeps every
  // version, and "I've sent it" marks which one went out), versioned per
  // bill rather than overwritten.
  const { data: latest } = await supabase
    .from("messages")
    .select("version")
    .eq("bill_id", billId)
    .eq("type", "dispute")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const version = (latest?.version ?? 0) + 1;

  // Proof chain: link the one line this disputes, only when there's
  // exactly one disputed line and it matches a stored row unambiguously.
  let lineItemId: string | null = null;
  if (facts.disputedLines.length === 1) {
    const target = facts.disputedLines[0];
    const { data: candidates } = await supabase
      .from("line_items")
      .select("id, label, amount")
      .eq("bill_id", billId);
    const matches = (candidates ?? []).filter(
      (li) => li.label === target.label && Math.abs(li.amount - target.amount) <= 0.01
    );
    if (matches.length === 1) lineItemId = matches[0].id;
  }

  const { data: promiseRow } = await supabase
    .from("promises")
    .select("id")
    .eq("bill_id", billId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: message, error: messageError } = await supabase
    .from("messages")
    .insert({
      bill_id: billId,
      line_item_id: lineItemId,
      promise_id: promiseRow?.id ?? null,
      subject: draft.subject,
      body: draft.body,
      tone,
      tone_preset_used: tonePreset,
      version,
      is_default_tone: isDefaultTone,
    })
    .select()
    .single();

  if (messageError || !message) {
    console.error("Message insert failed:", messageError);
    return json({ success: false, reason: "server_error", message: "Couldn't save the draft. Please try again." }, 500);
  }

  return json({ success: true, messageId: message.id, subject: draft.subject, body: draft.body, isDefaultTone }, 200);
}

function validatePayload(
  value: unknown
):
  | {
      ok: true;
      data: {
        billId: string;
        outcome: "confirmed_error" | "cannot_verify" | "unexplained";
        facts: Facts;
        tonePreset: TonePreset | null;
      };
    }
  | { ok: false; message: string } {
  if (typeof value !== "object" || value === null) return { ok: false, message: "Request body was missing." };
  const v = value as Record<string, unknown>;

  const billId = typeof v.billId === "string" ? v.billId : "";
  if (!billId) return { ok: false, message: "No bill id was given." };

  const outcome =
    v.outcome === "confirmed_error" || v.outcome === "cannot_verify" || v.outcome === "unexplained" ? v.outcome : null;
  if (!outcome) return { ok: false, message: "Invalid outcome." };

  const tonePreset = TONE_PRESETS.includes(v.tonePreset as TonePreset) ? (v.tonePreset as TonePreset) : null;

  if (typeof v.facts !== "object" || v.facts === null) return { ok: false, message: "Missing facts." };
  const f = v.facts as Record<string, unknown>;

  const provider = typeof f.provider === "string" ? f.provider : "";
  const billDate = typeof f.billDate === "string" ? f.billDate : "";
  const gap = typeof f.gap === "number" && Number.isFinite(f.gap) ? f.gap : null;
  const billedAmount = typeof f.billedAmount === "number" && Number.isFinite(f.billedAmount) ? f.billedAmount : null;
  const total = typeof f.total === "number" && Number.isFinite(f.total) ? f.total : null;
  if (!provider || !billDate || gap === null || billedAmount === null || total === null) {
    return { ok: false, message: "Facts were incomplete." };
  }
  const promisedAmount =
    typeof f.promisedAmount === "number" && Number.isFinite(f.promisedAmount) ? f.promisedAmount : null;
  const reconcilingBalanceLabel = typeof f.reconcilingBalanceLabel === "string" ? f.reconcilingBalanceLabel : null;

  const disputedLines: { label: string; amount: number }[] = [];
  if (Array.isArray(f.disputedLines)) {
    for (const raw of f.disputedLines) {
      if (typeof raw !== "object" || raw === null) continue;
      const line = raw as Record<string, unknown>;
      if (typeof line.label === "string" && typeof line.amount === "number" && Number.isFinite(line.amount)) {
        disputedLines.push({ label: line.label, amount: line.amount });
      }
    }
  }

  // Set only for reason "tax_overcharge" (lib/verdict.ts) -- every other
  // outcome/reason sends null, same as decideVerdict's own baseFacts.
  let taxFinding: Facts["taxFinding"] = null;
  if (typeof f.taxFinding === "object" && f.taxFinding !== null) {
    const tf = f.taxFinding as Record<string, unknown>;
    const effectiveRatePercent = typeof tf.effectiveRatePercent === "number" ? tf.effectiveRatePercent : null;
    const expectedRatePercent = typeof tf.expectedRatePercent === "number" ? tf.expectedRatePercent : null;
    if (effectiveRatePercent !== null && expectedRatePercent !== null) {
      taxFinding = {
        effectiveRatePercent,
        expectedRatePercent,
        hsnPrefix: typeof tf.hsnPrefix === "string" ? tf.hsnPrefix : null,
        sourceUrl: typeof tf.sourceUrl === "string" ? tf.sourceUrl : null,
      };
    }
  }

  return {
    ok: true,
    data: {
      billId,
      outcome,
      facts: {
        provider,
        billDate,
        billReference: null,
        disputedLines,
        gap,
        promisedAmount,
        billedAmount,
        total,
        reconcilingBalanceLabel,
        taxFinding,
      },
      tonePreset,
    },
  };
}
