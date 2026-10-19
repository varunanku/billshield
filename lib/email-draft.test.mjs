// Number-verification guard and template fallback. No network -- these are
// the pure functions draftEmail relies on. Run with:
//   node lib/email-draft.test.mjs
import assert from "node:assert/strict";
import { extractMoneyNumbers, allNumbersAreFacts, templateEmail } from "./email-draft.ts";

const facts = {
  provider: "Tata Power Delhi Distribution Limited",
  billDate: "2026-06-22",
  billReference: null,
  disputedLines: [{ label: "Time of Day (TOD) Surcharge (G)", amount: 584.0 }],
  gap: 584.0,
  promisedAmount: null,
  billedAmount: 11454.23,
  total: 11460.0,
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

console.log("\nAll email-draft tests passed.");
