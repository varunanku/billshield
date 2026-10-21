// Pure aggregation, no DB. Run with: node lib/tone-stats.test.mjs
import assert from "node:assert/strict";
import { computeToneStats, computeFunnel } from "./tone-stats.ts";

// A small fixture standing in for messages rows (type='dispute'):
// - bill A: default draft sent as-is, never regenerated.
// - bill B: default draft, then regenerated to "firm" (v2), sent with that
//   preset, edited before sending.
// - bill C: regenerated twice ("polite" v2, "firm" v3), never sent.
// - bill D: default draft, not sent at all (draftingEmail/not_sent).
const fixture = [
  { bill_id: "A", tone_preset_used: null, version: 1, is_default_tone: true, edited_before_send: false, action_taken: "sent_as_is" },

  { bill_id: "B", tone_preset_used: null, version: 1, is_default_tone: true, edited_before_send: null, action_taken: null },
  { bill_id: "B", tone_preset_used: "firm", version: 2, is_default_tone: false, edited_before_send: true, action_taken: "sent_with_tone_preset" },

  { bill_id: "C", tone_preset_used: null, version: 1, is_default_tone: true, edited_before_send: null, action_taken: null },
  { bill_id: "C", tone_preset_used: "polite", version: 2, is_default_tone: false, edited_before_send: null, action_taken: null },
  { bill_id: "C", tone_preset_used: "firm", version: 3, is_default_tone: false, edited_before_send: null, action_taken: null },

  { bill_id: "D", tone_preset_used: null, version: 1, is_default_tone: true, edited_before_send: null, action_taken: null },
];

{
  const stats = computeToneStats(fixture);

  // 2 of 4 bills (A, B) were actually sent.
  assert.equal(stats.emailsSent, 2);
  // Of those 2 sent, only A used the default tone -> 50%.
  assert.equal(stats.percentSentWithDefaultTone, 50);
  // Of those 2 sent, only B was edited before sending -> 50%.
  assert.equal(stats.percentEditedBeforeSend, 50);
  // 2 of 4 bills (B, C) have a version > 1 -> 50%.
  assert.equal(stats.percentRegeneratedAtLeastOnce, 50);
  // "firm" appears twice (B's v2, C's v3) vs "polite" once -> firm wins.
  assert.equal(stats.mostChosenTone, "firm");

  console.log("PASS: computeToneStats counts emailsSent, default-tone%, edited%, regenerated%, mode tone correctly");
}

// Edge case: no rows at all -- every percentage is 0, not NaN or a crash.
{
  const stats = computeToneStats([]);
  assert.equal(stats.emailsSent, 0);
  assert.equal(stats.percentSentWithDefaultTone, 0);
  assert.equal(stats.percentRegeneratedAtLeastOnce, 0);
  assert.equal(stats.percentEditedBeforeSend, 0);
  assert.equal(stats.mostChosenTone, null);
  console.log("PASS: computeToneStats handles an empty fixture without NaN");
}

// Funnel over message_events. Drafts:
// - m1: copied twice, then opened, then sent at 95% kept (default tone).
// - m2: opened only, sent at 80% kept, used a tone preset.
// - m3: copied only, never sent.
// - m4: sent with no handoff at all (null pct).
// - m5: nothing.
// - an event for a non-draft message id is ignored.
{
  const messages = [
    { id: "m1", is_default_tone: true },
    { id: "m2", is_default_tone: false },
    { id: "m3", is_default_tone: true },
    { id: "m4", is_default_tone: true },
    { id: "m5", is_default_tone: true },
  ];
  const ev = (message_id, event_type, draft_kept_pct, minute) => ({
    message_id,
    event_type,
    draft_kept_pct,
    created_at: `2026-10-21T10:${String(minute).padStart(2, "0")}:00Z`,
  });
  const events = [
    ev("m1", "copied", 100, 1),
    ev("m1", "copied", "96.50", 2), // numeric as a string, as PostgREST may return it
    ev("m1", "opened_email_app", 95, 3),
    ev("m1", "marked_sent", 95, 4),
    ev("m2", "opened_email_app", 80, 5),
    ev("m2", "marked_sent", 80, 6),
    ev("m3", "copied", 40, 7),
    ev("m4", "marked_sent", null, 8),
    ev("chat-row", "copied", 1, 9),
  ];
  const f = computeFunnel(messages, events);

  assert.equal(f.draftsGenerated, 5);
  assert.equal(f.draftsWithHandoff, 3, "m1, m2, m3");
  assert.equal(f.copiedOnly, 1, "m3");
  assert.equal(f.openedOnly, 1, "m2");
  assert.equal(f.copiedAndOpened, 1, "m1");
  assert.equal(f.confirmedSent, 3, "m1, m2, m4");
  assert.equal(f.confirmedSentAfterHandoff, 2, "m1, m2 -- m4 had no handoff");
  assert.equal(f.confirmedSentKept90, 1, "m1 only");
  // Handoff pcts: 100, 96.5, 95, 80, 40 -> median 95.
  assert.equal(f.medianKeptPctAtHandoff, 95);
  assert.equal(f.sentAfterToneChange, 1, "m2");
  console.log("PASS: computeFunnel -- handoff split, sends, after-handoff, >=90% kept, median, tone change");
}

// A send BEFORE the only handoff doesn't count as "after a handoff".
{
  const f = computeFunnel(
    [{ id: "x", is_default_tone: true }],
    [
      { message_id: "x", event_type: "marked_sent", draft_kept_pct: 100, created_at: "2026-10-21T10:00:00Z" },
      { message_id: "x", event_type: "copied", draft_kept_pct: 100, created_at: "2026-10-21T10:05:00Z" },
    ]
  );
  assert.equal(f.confirmedSent, 1);
  assert.equal(f.confirmedSentAfterHandoff, 0);
  console.log("PASS: computeFunnel -- send before handoff is not counted as after a handoff");
}

// Empty: zeros and a null median, no NaN.
{
  const f = computeFunnel([], []);
  assert.equal(f.draftsGenerated, 0);
  assert.equal(f.medianKeptPctAtHandoff, null);
  console.log("PASS: computeFunnel handles no data");
}

console.log("\nAll tone-stats tests passed.");
