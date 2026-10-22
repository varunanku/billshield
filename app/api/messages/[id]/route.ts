import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { draftKeptPct, originalDraftBody } from "@/lib/draft-kept";
import { idSchema, messageActionSchema, parseInput } from "@/lib/schemas";

type ApiResponse = { success: true } | { success: false; reason: "bad_request" | "unauthorized" | "server_error"; message: string };

function json(body: ApiResponse, status: number) {
  return NextResponse.json(body, { status });
}

// Records what the user actually did with a drafted message -- "I've sent
// it" -- plus final_body when the sent text differs from what was first
// generated. RLS (messages_update_own, keyed off bill_id ownership) is the
// real enforcement here; this route doesn't additionally check ownership.
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return json({ success: false, reason: "unauthorized", message: "Please sign in first." }, 401);
  }

  if (!idSchema.safeParse(id).success) {
    return json({ success: false, reason: "bad_request", message: "That ID isn't valid." }, 400);
  }
  const validated = parseInput(messageActionSchema, await request.json().catch(() => null));
  if (!validated.ok) {
    return json({ success: false, reason: "bad_request", message: validated.message }, 400);
  }
  const actionTaken = validated.data.action_taken;
  const finalBody = validated.data.final_body;

  const updates: Record<string, string | boolean> = { action_taken: actionTaken };
  if (finalBody !== undefined) {
    updates.final_body = finalBody;
    // Derived here, not trusted from the client -- edited_before_send
    // compares the actually-sent text against the stored generated body.
    const { data: current } = await supabase.from("messages").select("body").eq("id", id).single();
    updates.edited_before_send = current ? finalBody !== current.body : false;
  }

  const { error } = await supabase.from("messages").update(updates).eq("id", id);
  if (error) {
    console.error("Message action update failed:", error);
    return json({ success: false, reason: "server_error", message: "Couldn't save that. Please try again." }, 500);
  }

  // How much of the original default draft survived into what was sent.
  // A separate, best-effort update: the action above is already saved, and
  // a failure here (e.g. migration 0010 not applied yet) must not undo it.
  if (finalBody !== undefined) {
    const original = await originalDraftBody(supabase, id);
    if (original !== null) {
      const { error: pctError } = await supabase
        .from("messages")
        .update({ draft_kept_pct: draftKeptPct(original, finalBody) })
        .eq("id", id);
      if (pctError) console.error("draft_kept_pct update failed:", pctError);
    }
  }

  return json({ success: true }, 200);
}
