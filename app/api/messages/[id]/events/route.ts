import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { draftKeptPct, originalDraftBody } from "@/lib/draft-kept";

type ApiResponse = { success: true } | { success: false; reason: "bad_request" | "unauthorized" | "server_error"; message: string };

function json(body: ApiResponse, status: number) {
  return NextResponse.json(body, { status });
}

const EVENT_TYPES = ["copied", "opened_email_app", "marked_sent"];

// Records one funnel event (Copy / Open in email app / I've sent it) for a
// drafted email. draft_kept_pct is computed here from the editor text the
// client sends, against the bill's original default draft -- never a
// client-computed number. RLS (message_events_insert_own) enforces that
// the message belongs to this user; user_id comes from the session.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return json({ success: false, reason: "unauthorized", message: "Please sign in first." }, 401);
  }

  const body = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || !EVENT_TYPES.includes(body.event_type)) {
    return json({ success: false, reason: "bad_request", message: "Invalid event." }, 400);
  }
  const finalBody = typeof body.final_body === "string" ? body.final_body : null;

  const original = finalBody !== null ? await originalDraftBody(supabase, id) : null;
  const { error } = await supabase.from("message_events").insert({
    message_id: id,
    user_id: user.id,
    event_type: body.event_type,
    draft_kept_pct: original !== null && finalBody !== null ? draftKeptPct(original, finalBody) : null,
  });
  if (error) {
    console.error("Message event insert failed:", error);
    return json({ success: false, reason: "server_error", message: "Couldn't record that." }, 500);
  }

  return json({ success: true }, 200);
}
