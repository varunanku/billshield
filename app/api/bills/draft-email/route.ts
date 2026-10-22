import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { draftEmail, applySignature, type Tone, type TonePreset } from "@/lib/email-draft";
import type { Facts } from "@/lib/verdict";
import { draftEmailSchema, parseInput } from "@/lib/schemas";
import { checkRateLimit, clientIp, rulesFor, tooManyMessage } from "@/lib/rate-limit";

export const maxDuration = 30;

type ApiResponse =
  | { success: true; messageId: string; subject: string; body: string; isDefaultTone: boolean }
  | { success: false; reason: "bad_request" | "unauthorized" | "rate_limited" | "server_error"; message: string };

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

  // Covers the first draft and every Regenerate (both hit this route).
  const limit = await checkRateLimit(rulesFor("draftEmail", user.id, clientIp(request)));
  if (!limit.ok) {
    return json({ success: false, reason: "rate_limited", message: tooManyMessage(limit.retryAfterSeconds) }, 429);
  }
  // confirmed_error is the only confident-tone outcome -- cannot_verify and
  // unexplained both draft a soft inquiry (the wording differs between
  // them inside draftEmail, keyed off facts, not off outcome). A gap
  // against the user's expected amount (facts.expectedAmountGap) is
  // confirmed_error but always inquiry tone -- never worded as an error.
  const tone: Tone = outcome === "confirmed_error" && !facts.expectedAmountGap ? "confident" : "inquiry";
  const isDefaultTone = tonePreset === null;

  // RLS-scoped: this also confirms the bill belongs to the signed-in user.
  const { data: bill, error: billError } = await supabase
    .from("bills")
    .select("id")
    .eq("id", billId)
    .single();
  if (billError || !bill) {
    return json({ success: false, reason: "unauthorized", message: "That bill isn't in your account. Open one of your own bills from My bills." }, 401);
  }

  // Code, not the prompt -- the sign-off's "[Your Name]" placeholder is
  // swapped for the user's own first name (auth metadata, same source as
  // the header/thank-you toast) here, after the draft already exists, on
  // every draft including a Regenerate (both hit this same route). Left
  // as "[Your Name]" when there's no name to put there.
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

function validatePayload(value: unknown):
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
  const parsed = parseInput(draftEmailSchema, value);
  if (!parsed.ok) return parsed;
  return { ok: true, data: { ...parsed.data, facts: { ...parsed.data.facts, billReference: null } } };
}
