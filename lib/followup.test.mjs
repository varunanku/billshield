// Pure prompt-building for the follow-up chat. No network. Run with:
//   node lib/followup.test.mjs
import assert from "node:assert/strict";
import { buildFollowupSystemPrompt } from "./followup.ts";

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

console.log("\nAll followup tests passed.");
