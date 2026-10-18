import { createBrowserClient } from "@supabase/ssr";

// Browser-side Supabase client, for Client Components (sign-in/out). Anon
// key only -- safe to ship to the browser, every query still goes through
// RLS as whichever user is signed in.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
