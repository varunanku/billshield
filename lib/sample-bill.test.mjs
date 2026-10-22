// "Try a sample bill" runs the built-in example through the real checks,
// verdict and email code. Run with: node lib/sample-bill.test.mjs
import assert from "node:assert/strict";
import { SAMPLE_BILL } from "./sample-bill.ts";
import { computeBillChecks } from "./bill-checks.ts";
import { decideVerdict, shouldDraftEmail } from "./verdict.ts";
import { templateEmail, allNumbersAreFacts, totalClaimsAreCorrect, differenceClaimsAreCorrect } from "./email-draft.ts";
import { normalisePrintedHistory } from "./printed-history.ts";
import { parseInput, confirmSchema } from "./schemas.ts";

const checks = computeBillChecks(SAMPLE_BILL.line_items, SAMPLE_BILL.total);
const verdict = decideVerdict({
  lines: SAMPLE_BILL.line_items,
  total: SAMPLE_BILL.total,
  provider: SAMPLE_BILL.provider,
  billDate: SAMPLE_BILL.bill_date,
  checks,
  promise: null,
});

// Flagged by the ordinary checks: the Sub Total leaves out the TOD Surcharge.
assert.equal(verdict.outcome, "confirmed_error");
assert.equal(verdict.reason, "mismatch");
assert.deepEqual(verdict.facts.disputedLines, [{ label: "TOD Surcharge", amount: 584 }]);
assert.ok(shouldDraftEmail(verdict.facts));

// The sample's email is the code-built template and passes the number guard.
const email = templateEmail(verdict.facts, "confident");
assert.ok(email.body.includes("TOD Surcharge"));
assert.ok(allNumbersAreFacts(email, verdict.facts));
assert.ok(totalClaimsAreCorrect(email, verdict.facts));
assert.ok(differenceClaimsAreCorrect(email, verdict.facts));

// Its data is shaped like a real extraction: valid for confirm, and its
// printed history is already in normalised form.
assert.deepEqual(normalisePrintedHistory(SAMPLE_BILL.printed_history, SAMPLE_BILL.category), SAMPLE_BILL.printed_history);
assert.ok(parseInput(confirmSchema, { ...SAMPLE_BILL, path: "sample" }).ok);

console.log("PASS: sample bill -> flagged TOD Surcharge (Rs 584) by the real checks; template email passes the number guard");
