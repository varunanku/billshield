// Fixture-based test of parseGeminiResponse -- no network. Run with:
//   node lib/gemini.test.mjs
import assert from "node:assert/strict";
import { parseGeminiResponse } from "./gemini-parse.ts";

// Case 1: a plausible generateContent response body parses into the same
// shape extractBillFromImages would return from Groq.
{
  const fixture = {
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                provider: "Tata Power Delhi Distribution Limited",
                bill_date: "2026-06-22",
                total: 11460.0,
                line_items: [
                  { label: "Fixed Charges (F)", amount: 632.88, role: "charge" },
                  { label: "Electricity Tax @ 5%", amount: 480.31, role: "tax" },
                ],
              }),
            },
          ],
        },
      },
    ],
  };
  const result = parseGeminiResponse(fixture);
  assert.equal(result.ok, true);
  assert.equal(result.data.provider, "Tata Power Delhi Distribution Limited");
  assert.equal(result.data.total, 11460.0);
  assert.equal(result.data.line_items.length, 2);
  assert.equal(result.data.line_items[1].role, "tax");
  console.log("PASS: parseGeminiResponse parses a valid fixture into ExtractedBill");
}

// Case 2: a response with no candidates fails cleanly, not a crash.
{
  const result = parseGeminiResponse({ candidates: [] });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "extraction_failed");
  console.log("PASS: parseGeminiResponse handles an empty candidates array");
}

// Case 3: a non-JSON text part fails cleanly.
{
  const fixture = { candidates: [{ content: { parts: [{ text: "not json" }] } }] };
  const result = parseGeminiResponse(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.kind, "extraction_failed");
  console.log("PASS: parseGeminiResponse handles invalid JSON text");
}

console.log("\nAll gemini tests passed.");
