// Number-verification guard and template fallback. No network -- these are
// the pure functions draftEmail relies on. Run with:
//   node lib/email-draft.test.mjs
import assert from "node:assert/strict";
import {
  extractMoneyNumbers,
  allNumbersAreFacts,
  totalClaimsAreCorrect,
  differenceClaimsAreCorrect,
  templateEmail,
  buildPrompt,
  TONE_PRESETS,
  applySignature,
} from "./email-draft.ts";

const facts = {
  provider: "Tata Power Delhi Distribution Limited",
  billDate: "2026-06-22",
  billReference: null,
  disputedLines: [{ label: "Time of Day (TOD) Surcharge (G)", amount: 584.0 }],
  gap: 584.0,
  promisedAmount: null,
  billedAmount: 11454.23,
  total: 11460.0,
  reconcilingBalanceLabel: null,
  taxFinding: null,
};

// Case 1: extractMoneyNumbers ignores dates/percentages, catches money.
{
  const text = "Your bill dated 19 October 2026 includes an 18% tax and a charge of Rs 584.00, against a total of 11460.00.";
  const numbers = extractMoneyNumbers(text);
  assert.deepEqual(numbers.sort(), [584.0, 11460.0].sort(), "should find only the two money figures, not the date or percentage");
  console.log("PASS: extractMoneyNumbers ignores dates/percentages, finds money figures");
}

// Case 2: a draft using only numbers from facts passes the guard.
{
  const goodDraft = {
    subject: "Query about Time of Day (TOD) Surcharge",
    body: `Your bill shows a total of Rs 11460.00. The reconciled amount is Rs 11454.23, a difference of Rs 584.00 relating to the Time of Day (TOD) Surcharge (G) line.`,
  };
  assert.equal(allNumbersAreFacts(goodDraft, facts), true);
  console.log("PASS: allNumbersAreFacts accepts a draft using only fact numbers");
}

// Case 3: a draft with an invented number (not in facts) fails the guard
// -- this is what should trigger a regeneration, then the template fallback.
{
  const badDraft = {
    subject: "Query",
    body: `There appears to be a discrepancy of Rs 999.99 on your account.`,
  };
  assert.equal(allNumbersAreFacts(badDraft, facts), false, "999.99 isn't in facts, so this must fail");
  console.log("PASS: allNumbersAreFacts rejects a draft with an invented number");
}

// Case 4: the code-built template fallback only ever uses fact numbers
// (sanity check that the fallback itself would always pass its own guard).
{
  const confident = templateEmail(facts, "confident");
  assert.equal(allNumbersAreFacts(confident, facts), true, "the confident template must itself pass the number guard");

  const inquiry = templateEmail(facts, "inquiry");
  assert.equal(allNumbersAreFacts(inquiry, facts), true, "the inquiry template must itself pass the number guard");
  console.log("PASS: templateEmail's own output always passes the number guard");
}

// Case 5: totalClaimsAreCorrect -- a draft that calls billedAmount (a real
// fact number, so allNumbersAreFacts alone would pass it) "the total" is
// mislabelling, even though 11454.23 is genuinely in facts.
{
  const mislabelled = {
    subject: "Query",
    body: "The total on your bill is Rs 11454.23, which seems incorrect.",
  };
  assert.equal(allNumbersAreFacts(mislabelled, facts), true, "11454.23 is a real fact number");
  assert.equal(totalClaimsAreCorrect(mislabelled, facts), false, "but it isn't facts.total (11460.00)");
  console.log("PASS: totalClaimsAreCorrect catches a fact-accurate number mislabelled as 'the total'");
}

// Case 6: a draft correctly calling facts.total "the total" passes.
{
  const correct = {
    subject: "Query",
    body: "Your bill shows a total of Rs 11460.00.",
  };
  assert.equal(totalClaimsAreCorrect(correct, facts), true);
  console.log("PASS: totalClaimsAreCorrect accepts the real total labelled correctly");
}

// Case 7: the template fallback must also pass totalClaimsAreCorrect, not
// just allNumbersAreFacts.
{
  assert.equal(totalClaimsAreCorrect(templateEmail(facts, "confident"), facts), true);
  assert.equal(totalClaimsAreCorrect(templateEmail(facts, "inquiry"), facts), true);
  console.log("PASS: templateEmail's output always labels the total correctly");
}

// Case 8: cannot_verify's facts -- no disputed line, but a real (above
// MINOR_GAP_TOLERANCE) gap -- get the "small difference" wording, not the
// generic "could you confirm the charges are correct" inquiry phrasing,
// and still pass both number guards.
{
  const unpinpointedFacts = { ...facts, disputedLines: [], gap: 141.24 };
  const draft = templateEmail(unpinpointedFacts, "inquiry");
  assert.ok(draft.body.includes("small difference"), "should use the small-difference wording");
  assert.ok(draft.body.includes("141.24"));
  assert.equal(allNumbersAreFacts(draft, unpinpointedFacts), true);
  assert.equal(totalClaimsAreCorrect(draft, unpinpointedFacts), true);
  console.log("PASS: templateEmail uses small-difference wording for an unpinpointed gap");
}

// Case 9: changing the tone preset never changes which fact numbers the
// model is given -- the same set of money figures appears in the prompt
// no matter which of the 6 presets (or none) is requested.
{
  const baseline = extractMoneyNumbers(buildPrompt(facts, "confident", null)).sort();
  for (const preset of TONE_PRESETS) {
    const withPreset = extractMoneyNumbers(buildPrompt(facts, "confident", preset)).sort();
    assert.deepEqual(withPreset, baseline, `preset "${preset}" must not add/remove/change any fact number`);
  }
  console.log("PASS: every tone preset's prompt carries the exact same fact numbers");
}

// Case 10: differenceClaimsAreCorrect -- a draft that calls a real fact
// number (billedAmount) "the difference" is mislabelling, even though
// allNumbersAreFacts alone would pass it.
{
  const mislabelled = {
    subject: "Query",
    body: "The difference on your bill is Rs 11454.23, which seems incorrect.",
  };
  assert.equal(allNumbersAreFacts(mislabelled, facts), true, "11454.23 is a real fact number");
  assert.equal(differenceClaimsAreCorrect(mislabelled, facts), false, "but it isn't facts.gap (584.00)");

  const correct = { subject: "Query", body: "There is a difference of Rs 584.00 on your bill." };
  assert.equal(differenceClaimsAreCorrect(correct, facts), true);
  assert.equal(differenceClaimsAreCorrect(templateEmail(facts, "confident"), facts), true);
  assert.equal(differenceClaimsAreCorrect(templateEmail(facts, "inquiry"), facts), true);
  console.log("PASS: differenceClaimsAreCorrect catches a mislabelled difference, accepts the real one");
}

// Case 11: the real Hemant/Airtel overpayment case (item 1's own test) --
// paid 12165.08 against a billed 12023.96 charge, with the outstanding
// line (141.12) matching the excess exactly. The confident-tone template
// must mention all three figures, ask for a refund/adjustment, and
// reference the reconciling balance line as confirming the excess.
{
  const airtelFacts = {
    provider: "Airtel",
    billDate: "2026-09-01",
    billReference: null,
    disputedLines: [],
    gap: -141.12, // billedSum - amountPaid: negative = overpaid
    promisedAmount: null,
    billedAmount: 12023.96,
    total: 12165.08,
    reconcilingBalanceLabel: "OUTSTANDING_AMOUNT",
    taxFinding: null,
  };
  const draft = templateEmail(airtelFacts, "confident");

  assert.ok(draft.body.includes("141.12"), "should state the overpaid amount");
  assert.ok(draft.body.includes("12023.96"), "should state the billed amount");
  assert.ok(draft.body.includes("12165.08"), "should state the total/paid amount");
  assert.ok(/refund|adjustment/i.test(draft.body), "should ask for a refund or adjustment, not a correction");
  assert.ok(draft.body.includes("OUTSTANDING_AMOUNT"), "should mention the reconciling balance line");
  assert.equal(allNumbersAreFacts(draft, airtelFacts), true);
  assert.equal(totalClaimsAreCorrect(draft, airtelFacts), true);
  assert.equal(differenceClaimsAreCorrect(draft, airtelFacts), true);
  console.log("PASS: Airtel overpayment template -- states 141.12/12023.96/12165.08, asks for refund/adjustment, mentions the outstanding line");
}

// Case 12: Phase 3 -- a confirmed tax-overcharge finding (18% billed vs a
// 5% reference rate for HSN 2106, possible excess Rs 130.00). The template
// must ask the provider to CONFIRM the classification and refund the
// excess if applied in error -- never state as fact that the rate is wrong.
{
  const taxFacts = {
    provider: "BigBasket",
    billDate: "2026-03-10",
    billReference: null,
    disputedLines: [{ label: "CGST + SGST", amount: 180.0 }],
    gap: -130.0, // negative = excess the user may be owed back, same sign convention as overpaid
    promisedAmount: null,
    billedAmount: 1180.0,
    total: 1180.0,
    reconcilingBalanceLabel: null,
    taxFinding: { effectiveRatePercent: 18, expectedRatePercent: 5, hsnPrefix: "2106", sourceUrl: "https://cbic.gov.in/notif-09-2025" },
  };
  const draft = templateEmail(taxFacts, "confident");

  assert.ok(draft.body.includes("18.00%"), "should state the computed rate");
  assert.ok(draft.body.includes("5%"), "should state the reference rate");
  assert.ok(draft.body.includes("2106"), "should name the HSN code");
  assert.ok(draft.body.includes("130.00"), "should state the possible excess");
  assert.ok(/confirm/i.test(draft.body), "should ask the provider to confirm, not assert an error");
  assert.ok(!/you (applied|charged) .* in error/i.test(draft.body), "must never state as fact that the provider is wrong");
  assert.equal(allNumbersAreFacts(draft, taxFacts), true);
  assert.equal(differenceClaimsAreCorrect(draft, taxFacts), true);

  const prompt = buildPrompt(taxFacts, "confident", null);
  assert.ok(/confirm/i.test(prompt) && /refund/i.test(prompt), "prompt instructs: confirm classification, refund if in error");
  assert.ok(/never state as fact/i.test(prompt), "prompt explicitly forbids asserting the provider is wrong");
  console.log("PASS: tax-overcharge template asks the provider to confirm and refund, never asserts an error");
}

// Case 13: Phase 3 -- applySignature replaces the "[Your Name]" sign-off
// placeholder with the user's FIRST name, in code, after the draft exists
// (covers both templateEmail's own output and, identically, whatever an
// actual AI draft would carry) -- never touching the subject.
{
  const draft = templateEmail(facts, "confident");
  assert.ok(draft.body.includes("[Your Name]"), "templateEmail's own sign-off uses the placeholder");

  const signed = applySignature(draft, "Jane Doe");
  assert.ok(signed.body.includes("Jane"), "first name only");
  assert.ok(!signed.body.includes("Doe"), "never the surname");
  assert.ok(!signed.body.includes("[Your Name]"), "the placeholder itself is gone once replaced");
  assert.equal(signed.subject, draft.subject, "the subject is never touched");
  console.log("PASS: applySignature replaces [Your Name] with the first name when one exists");
}

// Case 14: no name -- the placeholder is left exactly as-is.
{
  const draft = templateEmail(facts, "confident");
  const unsigned = applySignature(draft, null);
  assert.deepEqual(unsigned, draft, "with no name, the draft is returned unchanged");
  assert.ok(unsigned.body.includes("[Your Name]"));
  console.log("PASS: applySignature keeps [Your Name] unchanged when no name exists");
}

// Case 15: case-insensitive, whitespace-flexible -- the actual bug report.
// An AI draft doesn't reliably reproduce templateEmail's exact "[Your
// Name]" casing/spacing; every variant actually seen must still match.
{
  const variants = [
    "Regards,\n[Your Name]",
    "Regards, \n[Your Name]",
    "Regards,\n[your name]",
    "Regards,\n[YOUR NAME]",
    "Regards,\n[ Your   Name ]",
  ];
  for (const body of variants) {
    const signed = applySignature({ subject: "Query", body }, "Priya Sharma");
    assert.ok(signed.body.includes("Priya"), `should replace the placeholder in: ${JSON.stringify(body)}`);
    assert.ok(!/\[\s*your\s+name\s*\]/i.test(signed.body), `no placeholder variant should survive: ${JSON.stringify(body)}`);
  }
  console.log("PASS: matches [Your Name] regardless of case or internal whitespace");
}

// Case 16: the exact Airtel draft wording the bug was reported against --
// the confident-tone template, signed end to end.
{
  const airtelFacts = {
    provider: "Airtel",
    billDate: "2026-09-01",
    billReference: null,
    disputedLines: [],
    gap: -141.12,
    promisedAmount: null,
    billedAmount: 12023.96,
    total: 12165.08,
    reconcilingBalanceLabel: "OUTSTANDING_AMOUNT",
    taxFinding: null,
  };
  const draft = templateEmail(airtelFacts, "confident");
  assert.ok(draft.body.includes("[Your Name]"));

  const signed = applySignature(draft, "Rahul Verma");
  assert.ok(signed.body.includes("Rahul"));
  assert.ok(!signed.body.includes("[Your Name]"));
  assert.ok(signed.body.includes("141.12"), "the figures are untouched by signing");
  console.log("PASS: the exact Airtel draft is signed with the first name");
}

console.log("\nAll email-draft tests passed.");
