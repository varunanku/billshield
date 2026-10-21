// Pure word-level similarity, no DB. Run with: node lib/draft-kept.test.mjs
import assert from "node:assert/strict";
import { draftKeptPct } from "./draft-kept.ts";

// A 50-word email body.
const original =
  "Dear Delhi Jal Board, my bill dated 2026-10-01 shows a total of Rs 1018.00. " +
  "I was expecting to pay Rs 970.00, the bill is higher than I expected. " +
  "Could you help me understand what makes up this amount and whether the surcharge applies? Thank you, Varun";
const wordCount = original.toLowerCase().match(/[\p{L}\p{N}]+/gu).length;
assert.equal(wordCount, 50, `fixture should be 50 words, is ${wordCount}`);

assert.equal(draftKeptPct(original, original), 100, "identical = 100");
assert.equal(
  draftKeptPct(original, original.replace(/\s+/g, "  ").toUpperCase().replace(/,/g, "")),
  100,
  "case, whitespace and punctuation are ignored"
);

const oneWordChanged = original.replace("understand", "see");
assert.equal(draftKeptPct(original, oneWordChanged), 98, "one word changed in a 50-word email = 98");

const rewrite = "Hi team, why is this month's water charge so high? Please call me back today. Thanks";
assert.ok(draftKeptPct(original, rewrite) < 15, `full rewrite near 0, got ${draftKeptPct(original, rewrite)}`);

assert.equal(draftKeptPct(original, ""), 0, "empty final = 0");
assert.equal(draftKeptPct("", "anything"), 0, "empty original = 0, never NaN");

// Rounded to 2 decimals: 2 of 3 words kept = 66.67.
assert.equal(draftKeptPct("one two three", "one three"), 66.67);

console.log("PASS: draftKeptPct -- identical 100, one word 98, rewrite near 0, empty 0, 2-decimal rounding");
