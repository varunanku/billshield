import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Supabase's email-confirmation link points here (see emailRedirectTo in
// app/login/page.tsx's signUp call) with a one-time `code` query param --
// exchanging it sets the session cookie, then sends the now-signed-in user
// to "/". No code (or an invalid one) sends them back to /login instead of
// leaving them stuck on a blank redirect target.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}/`);
    }
  }

  return NextResponse.redirect(`${origin}/login`);
}
