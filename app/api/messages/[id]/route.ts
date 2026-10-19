import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type ApiResponse = { success: true } | { success: false; reason: "bad_request" | "unauthorized" | "server_error"; message: string };

function json(body: ApiResponse, status: number) {
  return NextResponse.json(body, { status });
}

const ACTION_VALUES = ["sent_as_is", "sent_with_tone_preset", "sent_manually_edited", "not_sent"];

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

  const body = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null) {
    return json({ success: false, reason: "bad_request", message: "Request body was missing." }, 400);
  }
  const actionTaken = typeof body.action_taken === "string" ? body.action_taken : null;
  if (!actionTaken || !ACTION_VALUES.includes(actionTaken)) {
    return json({ success: false, reason: "bad_request", message: "Invalid action." }, 400);
  }
  const finalBody = typeof body.final_body === "string" ? body.final_body : undefined;

  const updates: Record<string, string> = { action_taken: actionTaken };
  if (finalBody !== undefined) updates.final_body = finalBody;

  const { error } = await supabase.from("messages").update(updates).eq("id", id);
  if (error) {
    console.error("Message action update failed:", error);
    return json({ success: false, reason: "server_error", message: "Couldn't save that. Please try again." }, 500);
  }

  return json({ success: true }, 200);
}
