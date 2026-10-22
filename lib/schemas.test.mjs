// Input validation for every API route. Pure, no network.
// Run with: node lib/schemas.test.mjs
import assert from "node:assert/strict";
import {
  parseInput,
  idSchema,
  extractSchema,
  confirmSchema,
  draftEmailSchema,
  followupSchema,
  applyCorrectionSchema,
  messageActionSchema,
  messageEventSchema,
} from "./schemas.ts";
import { sniffFileType } from "./file-type.ts";

const ok = (schema, v) => parseInput(schema, v).ok;
const msg = (schema, v) => parseInput(schema, v).message;
const id = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

// IDs
assert.equal(idSchema.safeParse(id).success, true);
assert.equal(idSchema.safeParse("1; drop table bills").success, false);
assert.equal(idSchema.safeParse("").success, false);

// Missing body -> plain message, never a crash.
assert.equal(msg(confirmSchema, null), "Bill data was missing.");
assert.equal(msg(extractSchema, null), "Request body was missing.");
assert.equal(ok(extractSchema, { path: "x".repeat(201) }), false, "path length capped");

// confirm
const bill = {
  path: `${id}/${id}.jpg`,
  provider: "  Tata Power  ",
  bill_date: "2026-06-22",
  total: 11460,
  category: "electricity",
  line_items: [{ label: "Energy Charges", amount: 9000, role: "charge" }],
};
{
  const r = parseInput(confirmSchema, bill);
  assert.ok(r.ok);
  assert.equal(r.data.provider, "Tata Power", "trimmed");
  assert.equal(r.data.promise, null);
  assert.equal(r.data.line_items[0].unrecognized, false);
}
assert.equal(msg(confirmSchema, { ...bill, total: "11460" }), "Please enter the bill total.");
assert.equal(msg(confirmSchema, { ...bill, total: 1e12 }), "That total is too large.");
assert.equal(msg(confirmSchema, { ...bill, bill_date: "22/06/2026" }), "Please enter a valid bill date.");
assert.equal(msg(confirmSchema, { ...bill, line_items: [] }), "At least one line item is required.");
assert.equal(ok(confirmSchema, { ...bill, line_items: Array(201).fill(bill.line_items[0]) }), false, "line count capped");
assert.equal(ok(confirmSchema, { ...bill, line_items: [{ label: "x".repeat(301), amount: 1, role: "charge" }] }), false);
assert.equal(ok(confirmSchema, { ...bill, line_items: [{ label: "x", amount: 1, role: "bogus" }] }), false, "role enum");
assert.equal(ok(confirmSchema, { ...bill, provider: "p".repeat(201) }), false);
// AI-read optional fields that are malformed fall back instead of blocking confirm.
{
  const r = parseInput(confirmSchema, { ...bill, category: "spaceships", billing_period_start: "March 2026", units_consumed: "lots" });
  assert.ok(r.ok);
  assert.equal(r.data.category, null);
  assert.equal(r.data.billing_period_start, null);
  assert.equal(r.data.units_consumed, null);
}
// A promise with an empty statement is no promise.
assert.equal(parseInput(confirmSchema, { ...bill, promise: { statement: "  ", promisedAmount: 5 } }).data.promise, null);
assert.equal(ok(confirmSchema, { ...bill, promise: { statement: "s".repeat(1001) } }), false);

// draft-email
const facts = { provider: "Airtel", billDate: "2026-10-01", gap: -141.12, billedAmount: 12023.96, total: 12165.08 };
{
  const r = parseInput(draftEmailSchema, { billId: id, outcome: "confirmed_error", facts });
  assert.ok(r.ok);
  assert.deepEqual(r.data.facts.disputedLines, []);
  assert.equal(r.data.tonePreset, null);
}
assert.equal(msg(draftEmailSchema, { billId: "nope", outcome: "confirmed_error", facts }), "That ID isn't valid.");
assert.equal(msg(draftEmailSchema, { billId: id, outcome: "clean", facts }), "Invalid outcome.");
assert.equal(ok(draftEmailSchema, { billId: id, outcome: "unexplained", facts, tonePreset: "rude" }), false, "tone enum");
assert.equal(ok(draftEmailSchema, { billId: id, outcome: "unexplained", facts: { ...facts, provider: "" } }), false);

// followup
const context = { total: 100, verdictOutcome: "clean", lineItems: [{ label: "A", amount: 100, role: "charge" }] };
assert.ok(ok(followupSchema, { question: "Why?", context }));
assert.equal(msg(followupSchema, { question: "   ", context }), "No question was given.");
assert.equal(msg(followupSchema, { question: "q".repeat(1001), context }), "That question is too long.");
assert.equal(ok(followupSchema, { question: "Why?", context: { ...context, verdictOutcome: "great" } }), false);

// apply-correction
assert.ok(ok(applyCorrectionSchema, { correction: { field: "printed_total", new_amount: 500 } }));
assert.equal(msg(applyCorrectionSchema, { correction: { field: "line" } }), "A line correction needs a line_index.");
assert.equal(ok(applyCorrectionSchema, { correction: { field: "line", line_index: 1.5 } }), false, "integer index");
assert.equal(ok(applyCorrectionSchema, { correction: { field: "line", line_index: -1 } }), false);
assert.equal(
  msg(applyCorrectionSchema, { correction: { field: "bill_date", new_label: "yesterday" } }),
  "A corrected bill date must look like YYYY-MM-DD."
);

// messages
assert.ok(ok(messageActionSchema, { action_taken: "sent_as_is", final_body: "Hi" }));
assert.equal(msg(messageActionSchema, { action_taken: "deleted" }), "Invalid action.");
assert.equal(msg(messageActionSchema, { action_taken: "sent_as_is", final_body: "x".repeat(20001) }), "That message is too long.");
assert.ok(ok(messageEventSchema, { event_type: "copied" }));
assert.equal(msg(messageEventSchema, { event_type: "liked" }), "Invalid event.");

console.log("PASS: zod schemas -- ids, lengths, ranges, enums, lenient AI fields, plain messages");

// Upload type comes from the file's own bytes.
{
  const b = (...xs) => new Uint8Array(xs);
  assert.equal(sniffFileType(b(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
  assert.equal(sniffFileType(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "image/png");
  assert.equal(sniffFileType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffFileType(new TextEncoder().encode("%PDF-1.7")), "application/pdf");
  assert.equal(sniffFileType(new TextEncoder().encode("<html><script>")), null, "HTML renamed .jpg is rejected");
  assert.equal(sniffFileType(new TextEncoder().encode("RIFF\0\0\0\0WAVE")), null, "RIFF but not WEBP");
  assert.equal(sniffFileType(new Uint8Array(0)), null);
  console.log("PASS: sniffFileType -- JPEG, PNG, WEBP, PDF by signature; anything else rejected");
}
