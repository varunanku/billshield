// Pure prompt-building for the follow-up chat. No network. Run with:
//   node lib/followup.test.mjs
import assert from "node:assert/strict";
import { buildFollowupSystemPrompt, parseFollowupReply, applyCorrection, buildHistoryResultTurn } from "./followup.ts";
import { computeBillChecks } from "./bill-checks.ts";
import { decideVerdict } from "./verdict.ts";

const context = {
  provider: "Tata Power Delhi Distribution Limited",
  billDate: "2026-06-22",
  total: 11454.23,
  lineItems: [
    { label: "Fixed Charges (F)", amount: 632.88, role: "charge" },
    { label: "Electricity Tax @ 5%", amount: 480.31, role: "tax" },
  ],
  verdictOutcome: "clean",
  verdictGap: null,
  disputedLines: [],
  warnings: [],
  printedHsnCodes: [],
};

// Case 1: every fact the LLM needs is actually in the prompt text.
{
  const prompt = buildFollowupSystemPrompt(context);
  assert.ok(prompt.includes("Tata Power Delhi Distribution Limited"));
  assert.ok(prompt.includes("11454.23"));
  assert.ok(prompt.includes("Fixed Charges (F)"));
  assert.ok(prompt.includes("632.88"));
  assert.ok(prompt.includes("clean"));
  console.log("PASS: buildFollowupSystemPrompt includes provider, total, line items, verdict");
}

// Case 2: the prompt explicitly forbids inventing numbers -- this is the
// one line doing the "LLM never computes numbers" hard rule's work here.
{
  const prompt = buildFollowupSystemPrompt(context);
  assert.ok(/never .*(compute|invent)|never state a number/i.test(prompt), "prompt must forbid inventing numbers");
  console.log("PASS: buildFollowupSystemPrompt forbids inventing/recomputing numbers");
}

// Case 3: a flagged bill's gap and disputed line show up too.
{
  const flagged = {
    ...context,
    verdictOutcome: "confirmed_error",
    verdictGap: 584.0,
    disputedLines: [{ label: "Time of Day (TOD) Surcharge (G)", amount: 584.0 }],
  };
  const prompt = buildFollowupSystemPrompt(flagged);
  assert.ok(prompt.includes("584.00"));
  assert.ok(prompt.includes("Time of Day (TOD) Surcharge (G)"));
  console.log("PASS: buildFollowupSystemPrompt includes gap and disputed line when flagged");
}

// Case 4: parseFollowupReply -- a plain answer.
{
  const reply = parseFollowupReply(JSON.stringify({ type: "answer", text: "This is the GST line." }));
  assert.equal(reply.type, "answer");
  assert.equal(reply.text, "This is the GST line.");
  console.log("PASS: parseFollowupReply parses a plain answer");
}

// Case 5: parseFollowupReply -- a correction proposal.
{
  const reply = parseFollowupReply(
    JSON.stringify({
      type: "correction",
      field: "line",
      line_index: 1,
      new_label: null,
      new_role: null,
      new_amount: 89.43,
      reason: "The printed amount is 89.43, not 89.40.",
    })
  );
  assert.equal(reply.type, "correction");
  assert.equal(reply.correction.field, "line");
  assert.equal(reply.correction.line_index, 1);
  assert.equal(reply.correction.new_amount, 89.43);
  console.log("PASS: parseFollowupReply parses a correction proposal");
}

// Case 6: parseFollowupReply -- malformed/non-JSON output falls back to a
// plain answer with the raw text, rather than erroring out.
{
  const reply = parseFollowupReply("Sorry, I'm not sure about that.");
  assert.equal(reply.type, "answer");
  assert.equal(reply.text, "Sorry, I'm not sure about that.");
  console.log("PASS: parseFollowupReply falls back to a plain answer for non-JSON text");
}

// Case 7: applyCorrection -- correcting a line amount re-runs checks/
// verdict with the new figure (the Tata TOD-surcharge fabrication, fixed
// via a proposed correction instead of a manual review-screen edit).
{
  const lines = [
    { label: "Fixed Charges (F)", amount: 632.88, role: "charge" },
    { label: "Time of Day (TOD) Surcharge (G)", amount: 584.0, role: "charge" },
    { label: "Net Current Demand", amount: 632.88, role: "subtotal" }, // the real (pre-fabrication) figure
  ];
  const state = { provider: "Tata Power", billDate: "2026-06-22", total: 632.88, lines };

  const before = computeBillChecks(state.lines, state.total);
  assert.ok(before.checkpoints[0].gap > 0, "the fabricated surcharge should show up as a checkpoint gap before the fix");

  const corrected = applyCorrection(state, {
    field: "line",
    line_index: 1,
    new_label: null,
    new_role: null,
    new_amount: 0,
    reason: "Not printed on the bill -- fabricated.",
  });
  const after = computeBillChecks(corrected.lines, corrected.total);
  const verdict = decideVerdict({
    lines: corrected.lines,
    total: corrected.total,
    provider: corrected.provider,
    billDate: corrected.billDate,
    checks: after,
    promise: null,
  });

  assertClose(after.checkpoints[0].gap, 0, "the checkpoint should reconcile once the fabricated line is zeroed");
  assert.equal(verdict.outcome, "clean", "re-running the verdict after the correction should now say clean");
  console.log("PASS: applyCorrection -> recomputed checks/verdict reflect a corrected line amount");
}

// Case 8: applyCorrection -- an out-of-range line_index is a no-op, never
// a crash or a silent guess.
{
  const state = { provider: "X", billDate: "2026-01-01", total: 100, lines: [{ label: "A", amount: 100, role: "charge" }] };
  const result = applyCorrection(state, {
    field: "line",
    line_index: 5,
    new_label: null,
    new_role: null,
    new_amount: 50,
    reason: "test",
  });
  assert.deepEqual(result, state, "an out-of-range line_index must leave the state unchanged");
  console.log("PASS: applyCorrection ignores an out-of-range line_index");
}

// Case 9: parseFollowupReply -- a get_history request, with months
// clamped and metric defaulted when given something unrecognized.
{
  const reply = parseFollowupReply(JSON.stringify({ type: "get_history", provider: "Airtel", metric: "units_consumed", months: 6 }));
  assert.equal(reply.type, "get_history");
  assert.equal(reply.request.provider, "Airtel");
  assert.equal(reply.request.metric, "units_consumed");
  assert.equal(reply.request.months, 6);

  const clamped = parseFollowupReply(JSON.stringify({ type: "get_history", provider: "Airtel", metric: "bogus", months: 999 }));
  assert.equal(clamped.request.metric, "total", "an unrecognized metric defaults to total");
  assert.equal(clamped.request.months, 24, "months is clamped to a sane maximum");
  console.log("PASS: parseFollowupReply parses and clamps a get_history request");
}

// Case 10: buildHistoryResultTurn -- the model is handed computed figures
// only, never asked to recompute, and a no-data case says so plainly.
{
  const turn = buildHistoryResultTurn(
    { provider: "Airtel", metric: "units_consumed", months: 3 },
    { count: 3, averageBeforeLatest: 110, latestValue: 140, latestDate: "2026-03-01" }
  );
  assert.equal(turn.role, "user");
  assert.ok(turn.content.includes("140"));
  assert.ok(turn.content.includes("110.00"));
  assert.ok(/only these numbers/i.test(turn.content));

  const empty = buildHistoryResultTurn({ provider: "Nobody", metric: "total", months: 3 }, { count: 0, averageBeforeLatest: null, latestValue: null, latestDate: null });
  assert.ok(/no past bills/i.test(empty.content));
  console.log("PASS: buildHistoryResultTurn hands the model only the computed figures");
}

function assertClose(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 0.005, `${message} (got ${actual}, expected ~${expected})`);
}

console.log("\nAll followup tests passed.");
