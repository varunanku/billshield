import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role Supabase client. Server-only (the key isn't NEXT_PUBLIC_, so
// it can't reach the browser) and bypasses RLS entirely -- only use it for
// things a signed-in user's own client genuinely can't do, and always
// re-check ownership yourself before trusting client-supplied input (e.g.
// a storage path), since RLS isn't doing that check for you here.
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}
