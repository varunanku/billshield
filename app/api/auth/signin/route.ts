import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseInput, signInSchema } from "@/lib/schemas";
import { checkRateLimit, clientIp, rulesFor, tooManyMessage } from "@/lib/rate-limit";

type ApiResponse = { success: true } | { success: false; reason: "bad_request" | "unauthorized" | "rate_limited"; message: string };

function json(body: ApiResponse, status: number) {
  return NextResponse.json(body, { status });
}

// Sign-in through the server, so attempts are rate-limited per email and
// per IP. The server client writes the session cookie on success.
export async function POST(request: Request) {
  const validated = parseInput(signInSchema, await request.json().catch(() => null));
  if (!validated.ok) return json({ success: false, reason: "bad_request", message: validated.message }, 400);
  const { email, password } = validated.data;

  const limit = await checkRateLimit(rulesFor("signin", email, clientIp(request)));
  if (!limit.ok) {
    return json({ success: false, reason: "rate_limited", message: tooManyMessage(limit.retryAfterSeconds) }, 429);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return json({ success: false, reason: "unauthorized", message: error.message }, 401);
  return json({ success: true }, 200);
}
