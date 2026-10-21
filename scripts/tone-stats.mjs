// Reports tone-preset usage across every dispute email (not follow-up chat
// rows) in the project. Run with:
//   node --env-file=.env.local scripts/tone-stats.mjs
//
// Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. This is an
// operator reporting script, not an end-user route -- it deliberately
// aggregates across every user's messages, which is why it uses the
// service role key rather than a signed-in user's RLS-scoped client. That
// key has no grants on public.messages by default; migration 0004 adds
// the one explicit `grant select ... to service_role` this script needs;
// migration 0011 adds the same for message_events (the funnel report).

import { createClient } from "@supabase/supabase-js";
import { computeToneStats, computeFunnel } from "../lib/tone-stats.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

const { data, error } = await admin
  .from("messages")
  .select("id, bill_id, tone_preset_used, version, is_default_tone, edited_before_send, action_taken")
  .eq("type", "dispute");

if (error) {
  console.error("Query failed:", error.message);
  process.exit(1);
}

const stats = computeToneStats(data ?? []);

console.log(`Emails sent: ${stats.emailsSent}`);
console.log(`Sent with default tone: ${stats.percentSentWithDefaultTone}%`);
console.log(`Regenerated at least once: ${stats.percentRegeneratedAtLeastOnce}%`);
console.log(`Most-chosen tone preset: ${stats.mostChosenTone ?? "n/a"}`);
console.log(`Edited before send: ${stats.percentEditedBeforeSend}%`);

const { data: events, error: eventsError } = await admin
  .from("message_events")
  .select("message_id, event_type, draft_kept_pct, created_at");

if (eventsError) {
  console.error("\nFunnel query failed (has migration 0011 been run?):", eventsError.message);
  process.exit(1);
}

const funnel = computeFunnel(data ?? [], events ?? []);

console.log("\nFunnel");
console.log(`Drafts generated: ${funnel.draftsGenerated}`);
console.log(`Drafts with any handoff (copied or opened): ${funnel.draftsWithHandoff}`);
console.log(`  Copied only: ${funnel.copiedOnly}`);
console.log(`  Opened only: ${funnel.openedOnly}`);
console.log(`  Both: ${funnel.copiedAndOpened}`);
console.log(`Confirmed sent (marked_sent): ${funnel.confirmedSent}`);
console.log(`Confirmed sent after a handoff: ${funnel.confirmedSentAfterHandoff}`);
console.log(`Confirmed sent with draft_kept_pct >= 90: ${funnel.confirmedSentKept90}`);
console.log(`Median draft_kept_pct at handoff: ${funnel.medianKeptPctAtHandoff ?? "n/a"}`);
console.log(`Sends after a tone change: ${funnel.sentAfterToneChange}`);
