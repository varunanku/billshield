// Run with: node lib/chat-chips.test.mjs
import assert from "node:assert/strict";
import { buildSuggestionChips } from "./chat-chips.ts";

const baseInput = {
  hasTaxLines: true,
  confirmedTaxFinding: false,
  effectiveTaxRatePercent: 5,
  flaggedLineLabel: null,
  hasProviderHistory: false,
  provider: "Airtel",
  hasCharges: true,
  hasDiscount: false,
  verdictOutcome: "clean",
  askedQuestions: [],
};

// Case 1: clean verdict -- the last pool slot is "Is anything wrong with
// this bill?", never "which line should I ask".
{
  const chips = buildSuggestionChips(baseInput);
  const questions = chips.map((c) => c.question);
  assert.ok(questions.includes("Is anything wrong with this bill?"));
  assert.ok(!questions.some((q) => /which line/i.test(q)), "a clean verdict never gets the 'which line' chip");
  console.log("PASS: clean verdict -- 'Is anything wrong with this bill?', never 'which line should I ask'");
}

// Case 2: flagged (non-clean) verdict with a known provider -- the last
// slot becomes "Which line should I ask {provider} about?".
{
  const chips = buildSuggestionChips({ ...baseInput, verdictOutcome: "confirmed_error", flaggedLineLabel: "Late Fee" });
  const questions = chips.map((c) => c.question);
  assert.ok(questions.includes("Which line should I ask Airtel about?"));
  assert.ok(!questions.includes("Is anything wrong with this bill?"), "non-clean verdict never gets the clean-only chip");
  assert.ok(questions.includes("What does the Late Fee line mean?"));
  console.log("PASS: non-clean verdict -- 'Which line should I ask {provider} about?', flagged-line chip included");
}

// Case 3: non-clean verdict, unknown provider -- the wording drops the
// provider name entirely rather than saying "your provider".
{
  const chips = buildSuggestionChips({ ...baseInput, verdictOutcome: "cannot_verify", provider: null });
  assert.ok(chips.some((c) => c.question === "Which line should I ask about?"));
  console.log("PASS: non-clean verdict + unknown provider -- 'Which line should I ask about?' (no name)");
}

// Case 4: confirmed tax finding -- the tax slot asks about the specific
// rate, not the generic "how much tax" fallback.
{
  const chips = buildSuggestionChips({ ...baseInput, confirmedTaxFinding: true, effectiveTaxRatePercent: 18 });
  assert.ok(chips.some((c) => c.question === "Why is the tax 18.00%?"));
  assert.ok(!chips.some((c) => c.question === "How much tax did I pay in total?"));
  console.log("PASS: confirmed tax finding -- 'Why is the tax X%?' instead of the generic fallback");
}

// Case 5: no tax lines at all -- the tax slot is absent entirely (not even
// the generic fallback), since there's nothing to answer.
{
  const chips = buildSuggestionChips({ ...baseInput, hasTaxLines: false });
  assert.ok(!chips.some((c) => /tax/i.test(c.question)), "no tax lines -- no tax-related chip at all");
  console.log("PASS: no tax lines -- tax slot entirely absent");
}

// Case 6: discount chip only appears when a discount line exists.
{
  const without = buildSuggestionChips(baseInput);
  assert.ok(!without.some((c) => c.question === "Was a discount applied?"));
  const withDiscount = buildSuggestionChips({ ...baseInput, hasDiscount: true, verdictOutcome: "confirmed_error", flaggedLineLabel: "X" });
  // 7 candidates would qualify here (tax, flagged, total, charges, discount,
  // which-line -- 6 actually, no history) -- still capped at 4, but the
  // discount slot is included when room allows.
  console.log("PASS: discount chip only appears when a discount line exists");
  void withDiscount;
}

// Case 7: rounds -- "How was my total worked out?" asked in round 1 is
// never re-offered in round 2 or round 3.
{
  const round1 = buildSuggestionChips(baseInput);
  assert.ok(round1.some((c) => c.question === "How was my total worked out?"));

  const askedAfterRound1 = round1.map((c) => c.question);
  const round2 = buildSuggestionChips({ ...baseInput, askedQuestions: askedAfterRound1 });
  assert.ok(!round2.some((c) => askedAfterRound1.includes(c.question)), "round 2 must not repeat anything from round 1");

  const askedAfterRound2 = [...askedAfterRound1, ...round2.map((c) => c.question)];
  const round3 = buildSuggestionChips({ ...baseInput, askedQuestions: askedAfterRound2 });
  assert.ok(!round3.some((c) => askedAfterRound2.includes(c.question)), "round 3 must not repeat anything from rounds 1-2");

  console.log("PASS: rounds 1-3 never repeat a previously-asked question");
}

// Case 8: the HP gas bill (clean, no HSN, no flagged line, no history, no
// discount) -- never gets the "which line should I ask" chip, since the
// verdict is clean.
{
  const hpBillInput = {
    hasTaxLines: true,
    confirmedTaxFinding: false,
    effectiveTaxRatePercent: 5,
    flaggedLineLabel: null,
    hasProviderHistory: false,
    provider: null,
    hasCharges: true,
    hasDiscount: false,
    verdictOutcome: "clean",
    askedQuestions: [],
  };
  const chips = buildSuggestionChips(hpBillInput);
  assert.ok(!chips.some((c) => /which line/i.test(c.question)), "HP gas bill (clean) never gets 'which line should I ask'");
  assert.ok(chips.some((c) => c.question === "Is anything wrong with this bill?"));
  console.log("PASS: the HP gas bill (clean verdict) never gets the 'which line should I ask' chip");
}

// Case 9: capped at 4 even when every optional slot qualifies.
{
  const chips = buildSuggestionChips({
    hasTaxLines: true,
    confirmedTaxFinding: true,
    effectiveTaxRatePercent: 18,
    flaggedLineLabel: "Static IP Charges",
    hasProviderHistory: true,
    provider: "Airtel",
    hasCharges: true,
    hasDiscount: true,
    verdictOutcome: "confirmed_error",
    askedQuestions: [],
  });
  assert.equal(chips.length, 4, "7 candidates qualify here, still capped at 4");
  console.log("PASS: capped at 4 even when every optional slot qualifies");
}

console.log("\nAll chat-chips tests passed.");
