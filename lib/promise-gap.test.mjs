// A gap between the bill and the amount the user expected is never worded
// as a confirmed error. Golden case: a Delhi Jal Board bill. No network.
// Run with: node lib/promise-gap.test.mjs
import assert from "node:assert/strict";
import { computeBillChecks } from "./bill-checks.ts";
import { decideVerdict, expectedAmountHeadline, findLineMatchingGap } from "./verdict.ts";
import {
  templateEmail,
  buildPrompt,
  allNumbersAreFacts,
  totalClaimsAreCorrect,
  differenceClaimsAreCorrect,
  passesWordingGuard,
} from "./email-draft.ts";
import { buildFollowupSystemPrompt } from "./followup.ts";

const ERROR_WORDING = /\berror\b|incorrect|\bwrong\b|correct (this|the|it)|correction|revised bill|refund|overcharg/i;

function djb(arrearRole) {
  const lines = [
    { label: "Water Charges", amount: 426.98, role: "charge" },
    { label: "Sewer Charges", amount: 256.19, role: "charge" },
    { label: "Service Charges", amount: 285.51, role: "charge" },
    { label: "Sub Total", amount: 968.68, role: "subtotal" },
    { label: "Arrear", amount: 0.21, role: arrearRole },
    { label: "Late Payment Surcharge", amount: 48.44, role: "charge" },
  ];
  const checks = computeBillChecks(lines, 1018);
  const verdict = decideVerdict({
    lines,
    total: 1018,
    provider: "Delhi Jal Board",
    billDate: "2026-10-01",
    checks,
    promise: { statement: "I expected around 970.", promisedAmount: 970 },
  });
  return { lines, verdict };
}

// The arrear line could be read as a charge or a balance -- same answer either way.
for (const arrearRole of ["charge", "balance"]) {
  const { lines, verdict } = djb(arrearRole);

  // Verdict: gap against the PRINTED total (1018 - 970 = 48.00), not the
  // reconciled billed sum (which would give 47.33 / 47.12).
  assert.equal(verdict.outcome, "confirmed_error");
  assert.equal(verdict.reason, "promise_mismatch");
  assert.equal(verdict.tone, "inquiry");
  assert.ok(Math.abs(verdict.facts.gap - 48.0) < 0.001, `gap should be 48.00, got ${verdict.facts.gap}`);
  assert.equal(verdict.facts.total, 1018);
  assert.equal(verdict.facts.expectedAmountGap.matchedLineLabel, "Late Payment Surcharge");

  // Headline.
  const headline = expectedAmountHeadline(verdict.facts);
  assert.equal(
    headline,
    "This bill is Rs 48.00 higher than the amount you expected -- it matches the Late Payment Surcharge line."
  );
  assert.ok(!/promised/i.test(headline), "never 'charged more than promised'");

  // Email: inquiry-toned template, same 48.00, no error wording, passes the
  // (unchanged) number guard.
  const email = templateEmail(verdict.facts, verdict.tone);
  const text = `${email.subject} ${email.body}`;
  assert.ok(text.includes("48.00"), "email states the same gap");
  assert.ok(text.includes("1018.00") && text.includes("970.00"));
  assert.ok(text.includes("Late Payment Surcharge"), "email names the matching line");
  assert.ok(!ERROR_WORDING.test(text), `email has error wording: ${text}`);
  assert.ok(allNumbersAreFacts(email, verdict.facts));
  assert.ok(totalClaimsAreCorrect(email, verdict.facts));
  assert.ok(differenceClaimsAreCorrect(email, verdict.facts));
  assert.ok(passesWordingGuard(email, verdict.facts));

  // The prompt asks for clarification, never a correction.
  const prompt = buildPrompt(verdict.facts, verdict.tone, null);
  assert.ok(prompt.includes("Difference: Rs 48.00"));
  assert.ok(prompt.includes("NOT a confirmed error"));
  assert.ok(!prompt.includes("Ask for a correction"));

  // Chat facts: the same 48.00, described as higher than expected, naming the line.
  const chat = buildFollowupSystemPrompt({
    provider: "Delhi Jal Board",
    billDate: "2026-10-01",
    total: 1018,
    lineItems: lines,
    verdictOutcome: verdict.outcome,
    verdictGap: verdict.facts.gap,
    disputedLines: [],
    warnings: [],
    printedHsnCodes: [],
    taxTotal: 0,
    expectedAmount: { promisedAmount: 970, matchedLineLabel: verdict.facts.expectedAmountGap.matchedLineLabel },
  });
  assert.ok(chat.includes("Rs 48.00 -- the printed total is this much higher than the Rs 970.00"));
  assert.ok(chat.includes('matches the "Late Payment Surcharge" line'));
  assert.ok(!chat.includes("owed/undercharged"));
}
console.log("PASS: Delhi Jal Board -- gap 48.00 vs printed total, names Late Payment Surcharge, inquiry email, chat facts match");

// The wording guard rejects an accusatory model draft for this case only.
{
  const { verdict } = djb("charge");
  const bad = { subject: "Billing error", body: "Please correct this error and issue a revised bill." };
  assert.equal(passesWordingGuard(bad, verdict.facts), false);
  assert.equal(passesWordingGuard(bad, { ...verdict.facts, expectedAmountGap: null }), true, "other outcomes untouched");
  console.log("PASS: wording guard rejects error wording only for expected-amount gaps");
}

// Line matching: within Rs 2, exactly one line, positive gap only.
{
  const lines = [
    { label: "A", amount: 100, role: "charge" },
    { label: "Surcharge", amount: 49.9, role: "charge" },
    { label: "Sub Total", amount: 48, role: "subtotal" },
  ];
  assert.equal(findLineMatchingGap(lines, 48), "Surcharge", "1.90 away is within Rs 2; subtotal ignored");
  assert.equal(findLineMatchingGap(lines, 45), null, "4.90 away is not a match");
  assert.equal(findLineMatchingGap([...lines, { label: "Other", amount: 47, role: "charge" }], 48), null, "two matches -> none named");
  assert.equal(findLineMatchingGap(lines, -48), null, "a lower-than-expected bill names no line");
  console.log("PASS: findLineMatchingGap -- Rs 2 tolerance, single match only");
}

// No match -> plain headline.
{
  const lines = [{ label: "Plan", amount: 588.82, role: "charge" }];
  const checks = computeBillChecks(lines, 588.82);
  const verdict = decideVerdict({ lines, total: 588.82, provider: "X", billDate: "2026-10-01", checks, promise: { statement: "", promisedAmount: 399 } });
  assert.equal(expectedAmountHeadline(verdict.facts), "This bill is Rs 189.82 higher than the amount you expected.");
  console.log("PASS: no matching line -> headline without a line name");
}

console.log("\nAll promise-gap tests passed.");
