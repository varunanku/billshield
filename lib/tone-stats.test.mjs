// Pure aggregation, no DB. Run with: node lib/tone-stats.test.mjs
import assert from "node:assert/strict";
import { computeToneStats } from "./tone-stats.ts";

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

console.log("\nAll tone-stats tests passed.");
