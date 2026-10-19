// Fixture-based test of parseOpenRouterResponse -- no network. Run with:
//   node lib/openrouter.test.mjs
import assert from "node:assert/strict";
import { parseOpenRouterResponse } from "./openrouter-parse.ts";

// Case 1: a plausible OpenAI-compatible chat completions response body
// parses into the same shape extractBillFromImages would return from Groq
// -- OpenRouter's response is choices[0].message.content, same as Groq's own.
{
  const fixture = {
    choices: [
      {
        message: {
          role: "assistant",
          content: JSON.stringify({
            provider: "Tata Power Delhi Distribution Limited",
            bill_date: "2026-06-22",
            total: 11460.0,
            line_items: [
              { label: "Fixed Charges (F)", amount: 632.88, role: "charge" },
              { label: "Electricity Tax @ 5%", amount: 480.31, role: "tax" },
            ],
          }),
        },
      },
    ],
  };
  const result = parseOpenRouterResponse(fixture);
  assert.equal(result.ok, true);
  assert.equal(result.data.provider, "Tata Power Delhi Distribution Limited");
  assert.equal(result.data.total, 11460.0);
  assert.equal(result.data.line_items.length, 2);
  assert.equal(result.data.line_items[1].role, "tax");
  console.log("PASS: parseOpenRouterResponse parses a valid fixture into ExtractedBill");
}

// Case 2: a response with no choices fails cleanly, not a crash.
{
  const result = parseOpenRouterResponse({ choices: [] });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "extraction_failed");
  console.log("PASS: parseOpenRouterResponse handles an empty choices array");
}

// Case 3: a non-JSON content string fails cleanly.
{
  const fixture = { choices: [{ message: { content: "not json" } }] };
  const result = parseOpenRouterResponse(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.kind, "extraction_failed");
  console.log("PASS: parseOpenRouterResponse handles invalid JSON content");
}

// Case 4: a malformed body (no choices key at all) fails cleanly.
{
  const result = parseOpenRouterResponse(null);
  assert.equal(result.ok, false);
  assert.equal(result.kind, "extraction_failed");
  console.log("PASS: parseOpenRouterResponse handles a null/malformed body");
}

console.log("\nAll openrouter tests passed.");
