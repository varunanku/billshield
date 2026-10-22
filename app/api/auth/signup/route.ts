import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { signUpMetadata } from "@/lib/auth";
import { parseInput, signUpSchema } from "@/lib/schemas";
import { checkRateLimit, clientIp, rulesFor, tooManyMessage } from "@/lib/rate-limit";

type ApiResponse = { success: true } | { success: false; reason: "bad_request" | "rate_limited"; message: string };

function json(body: ApiResponse, status: number) {
  return NextResponse.json(body, { status });
}

// Sign-up goes through the server so it can be validated (password >= 8,
// name trimmed and length-limited, email normalised) and rate-limited per
// email and per IP before Supabase sees it. Public by nature: there is no
// signed-in user yet. Supabase Auth's own limits and CAPTCHA (dashboard)
// still matter, since the public anon key could call Supabase directly.
export async function POST(request: Request) {
  const validated = parseInput(signUpSchema, await request.json().catch(() => null));
  if (!validated.ok) return json({ success: false, reason: "bad_request", message: validated.message }, 400);
  const { email, password, fullName } = validated.data;

  const limit = await checkRateLimit(rulesFor("signup", email, clientIp(request)));
  if (!limit.ok) {
    return json({ success: false, reason: "rate_limited", message: tooManyMessage(limit.retryAfterSeconds) }, 429);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // This request's own origin -- works the same on localhost, a Vercel
      // preview deploy, and production.
      emailRedirectTo: `${new URL(request.url).origin}/auth/callback`,
      data: signUpMetadata(fullName),
    },
  });
  if (error) {
    if (/rate limit/i.test(error.message)) {
      return json(
        { success: false, reason: "rate_limited", message: "Too many sign-ups right now. Please wait a few minutes and try again." },
        429
      );
    }
    return json({ success: false, reason: "bad_request", message: error.message }, 400);
  }
  return json({ success: true }, 200);
}
