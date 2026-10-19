// Run with: node lib/date-check.test.mjs
import assert from "node:assert/strict";
import { isSuspiciousBillDate } from "./date-check.ts";

const now = new Date("2026-10-19");

assert.equal(isSuspiciousBillDate("2026-10-01", now), false, "a recent, past date is fine");
assert.equal(isSuspiciousBillDate("2026-11-01", now), true, "a future date is suspicious");
assert.equal(isSuspiciousBillDate("2025-06-01", now), false, "16 months back is within tolerance");
assert.equal(isSuspiciousBillDate("1924-06-22", now), true, "a 2-digit-year misread (1924 instead of 2024) is suspicious");
assert.equal(isSuspiciousBillDate("not a date", now), false, "an unparseable date is never flagged, not a crash");
console.log("PASS: isSuspiciousBillDate -- future, >18 months back, and misread years all flagged");

console.log("\nAll date-check tests passed.");
