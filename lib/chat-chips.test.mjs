// Run with: node lib/chat-chips.test.mjs
import assert from "node:assert/strict";
import { buildSuggestionChips } from "./chat-chips.ts";

// Case 1: tax lines present -- the tax chip leads, both always-available
// fallbacks still fit within the 4-chip cap since nothing else applies.
{
  const chips = buildSuggestionChips({
    effectiveTaxRatePercent: 18,
    flaggedLineLabel: null,
    hasProviderHistory: false,
    provider: "Airtel",
  });
  assert.equal(chips.length, 3);
  assert.equal(chips[0].question, "Why is the tax 18.00%?");
  assert.equal(chips[1].question, "How was my total worked out?");
  assert.equal(chips[2].question, "Which line should I ask Airtel about?");
  console.log("PASS: tax present -- tax chip leads, provider named in the fallback");
}

// Case 2: verdict flagged a specific line.
{
  const chips = buildSuggestionChips({
    effectiveTaxRatePercent: null,
    flaggedLineLabel: "Late Payment Surcharge",
    hasProviderHistory: false,
    provider: null,
  });
  assert.equal(chips.length, 3);
  assert.equal(chips[0].question, "What does the Late Payment Surcharge line mean?");
  assert.equal(chips[1].question, "How was my total worked out?");
  assert.equal(chips[2].question, "Which line should I ask about?", "unknown provider -- wording skipped, chip still shown");
  console.log("PASS: flagged line present -- its chip leads, provider wording skipped when unknown");
}

// Case 3: history exists for a known provider.
{
  const chips = buildSuggestionChips({
    effectiveTaxRatePercent: null,
    flaggedLineLabel: null,
    hasProviderHistory: true,
    provider: "Tata Power",
  });
  assert.equal(chips.length, 3);
  assert.equal(chips[0].question, "Is this higher than my last Tata Power bill?");
  console.log("PASS: history present for a known provider -- its chip leads");
}

// Case 4: none of tax/flagged-line/history apply -- only the two
// always-available fallbacks show.
{
  const chips = buildSuggestionChips({
    effectiveTaxRatePercent: null,
    flaggedLineLabel: null,
    hasProviderHistory: false,
    provider: "Airtel",
  });
  assert.equal(chips.length, 2);
  assert.equal(chips[0].question, "How was my total worked out?");
  assert.equal(chips[1].question, "Which line should I ask Airtel about?");
  console.log("PASS: none of tax/flagged-line/history -- only the two fallbacks show");
}

// Case 5: unknown provider (null) suppresses the history chip even when
// hasProviderHistory is true, and the fallback drops the provider wording.
{
  const chips = buildSuggestionChips({
    effectiveTaxRatePercent: null,
    flaggedLineLabel: null,
    hasProviderHistory: true,
    provider: null,
  });
  assert.equal(chips.length, 2, "history chip needs a KNOWN provider, not just hasProviderHistory");
  assert.equal(chips[0].question, "How was my total worked out?");
  assert.equal(chips[1].question, "Which line should I ask about?");
  console.log("PASS: unknown provider -- history chip suppressed, fallback wording skipped");
}

// Case 5b: the "your provider" placeholder (confirm's own sentinel for an
// unrecognised provider) is treated the same as an unknown/null provider.
{
  const chips = buildSuggestionChips({
    effectiveTaxRatePercent: null,
    flaggedLineLabel: null,
    hasProviderHistory: true,
    provider: "your provider",
  });
  assert.equal(chips.length, 2);
  assert.equal(chips[1].question, "Which line should I ask about?");
  console.log("PASS: the 'your provider' placeholder is treated as unknown too");
}

// Case 6: all three optional chips apply at once -- capped at 4 total,
// dropping the lowest-priority fallback ("which line to ask about").
{
  const chips = buildSuggestionChips({
    effectiveTaxRatePercent: 5,
    flaggedLineLabel: "Static IP Charges",
    hasProviderHistory: true,
    provider: "Airtel",
  });
  assert.equal(chips.length, 4, "capped at 4 even though 5 candidates qualify");
  assert.equal(chips[0].question, "Why is the tax 5.00%?");
  assert.equal(chips[1].question, "What does the Static IP Charges line mean?");
  assert.equal(chips[2].question, "Is this higher than my last Airtel bill?");
  assert.equal(chips[3].question, "How was my total worked out?");
  console.log("PASS: all three optional chips -- capped at 4, drops the lowest-priority fallback");
}

console.log("\nAll chat-chips tests passed.");
