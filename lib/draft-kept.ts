// How much of the first draft the user kept when they sent it. Pure word-
// level similarity: lowercase word tokens (letters/digits only, so
// punctuation and whitespace never count), longest common subsequence of
// those tokens, divided by the number of words in the original, x 100,
// rounded to 2 decimals.
import type { SupabaseClient } from "@supabase/supabase-js";

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

// ponytail: O(n*m) LCS with a rolling row -- fine for email-sized text
// (a few hundred words); switch to a diff library if bodies get huge.
function lcsLength(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    }
    prev = row;
  }
  return prev[b.length];
}

export function draftKeptPct(original: string, final: string): number {
  const a = words(original);
  if (a.length === 0) return 0;
  const kept = lcsLength(a, words(final));
  return Math.round((kept / a.length) * 100 * 100) / 100;
}

// The original default draft for the bill this message belongs to:
// version 1 with no tone preset. RLS-scoped (the caller's own client), so
// a message on someone else's bill simply returns null.
export async function originalDraftBody(supabase: SupabaseClient, messageId: string): Promise<string | null> {
  const { data: message } = await supabase.from("messages").select("bill_id").eq("id", messageId).maybeSingle();
  if (!message) return null;
  const { data: original } = await supabase
    .from("messages")
    .select("body")
    .eq("bill_id", message.bill_id)
    .eq("type", "dispute")
    .eq("version", 1)
    .eq("is_default_tone", true)
    .limit(1)
    .maybeSingle();
  return original?.body ?? null;
}
