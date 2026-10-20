// Pure, no network -- the exact shape of the user metadata sign-up sends
// Supabase, pulled out so it's testable without mocking the Supabase
// client. The signup trigger (supabase/migrations/0009_user_full_name.sql)
// reads this same key (full_name) out of auth metadata.
export function signUpMetadata(fullName: string): { full_name: string } {
  return { full_name: fullName.trim() };
}
