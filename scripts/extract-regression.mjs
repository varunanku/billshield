// Regression check for lib/groq.ts's extraction prompt: runs the real
// extraction 3 times against a local image and asserts a set of expected
// lines (amount, and optionally role) shows up in every single run. Catches
// exactly the failure this was built for -- a model that only sometimes
// extracts a printed component line, which a single run would never
// surface.
//
// Usage:
//   node --env-file=.env.local scripts/extract-regression.mjs <imagePath> <expectedJsonPath> [runs] [--provider=gemini|groq]
//
// Both path arguments point OUTSIDE this repo on purpose -- a real bill
// photo and its expected-lines fixture are not something to commit.
// expectedJsonPath is a JSON array of { label, amount, role? }; label is
// informational only (logged, not asserted -- transcription wording can
// drift trivially even at temperature 0), amount is matched within 0.01,
// role is checked only if given. [runs] defaults to 3, so a routine check
// stays comfortably inside the account's rate limit; pass a higher number
// (e.g. 5) when specifically hunting for an intermittent issue.
//
// ponytail: image files only, no PDF-to-image step here -- add
// lib/pdf-to-images.ts if you need to regression-test a PDF bill.

import fs from "node:fs";
import path from "node:path";
import { extractBillFromImages as extractWithGroq } from "../lib/groq.ts";
import { extractBillFromImages as extractWithGemini } from "../lib/gemini.ts";

const EPSILON = 0.01;

// Defaults to groq -- keeps this pre-existing script's behavior stable
// regardless of what EXTRACTION_PROVIDER the app itself is set to.
const providerArg = process.argv.find((a) => a.startsWith("--provider="));
const provider = providerArg ? providerArg.split("=")[1] : "groq";
if (provider !== "groq" && provider !== "gemini") {
  console.error(`--provider must be "groq" or "gemini", got "${provider}"`);
  process.exit(1);
}
const extractBillFromImages = provider === "gemini" ? extractWithGemini : extractWithGroq;

const [imagePath, expectedPath, runsArg] = process.argv.slice(2).filter((a) => !a.startsWith("--provider="));
if (!imagePath || !expectedPath) {
  console.error("Usage: node scripts/extract-regression.mjs <imagePath> <expectedJsonPath> [runs] [--provider=gemini|groq]");
  process.exit(1);
}
const RUNS = runsArg ? Number(runsArg) : 3;
if (!Number.isInteger(RUNS) || RUNS < 1) {
  console.error(`[runs] must be a positive integer, got "${runsArg}"`);
  process.exit(1);
}

const EXT_MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const ext = path.extname(imagePath).toLowerCase();
const mimeType = EXT_MIME[ext];
if (!mimeType) {
  console.error(`Unsupported image extension "${ext}". Expected one of: ${Object.keys(EXT_MIME).join(", ")}`);
  process.exit(1);
}

const bytes = fs.readFileSync(imagePath);
const expectedLines = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
if (!Array.isArray(expectedLines) || expectedLines.length === 0) {
  console.error("Expected-lines JSON must be a non-empty array of { label, amount, role? }.");
  process.exit(1);
}

// If the fixture includes a subtotal entry, also check the section it
// closes: every charge/tax/discount line before it must be one we expected
// (catches an extra/fabricated line the per-expected-line check above
// wouldn't, since that check only looks for presence, never absence), and
// those lines must actually sum to the subtotal's printed amount.
const subtotalExpected = expectedLines.find((e) => e.role === "subtotal");
const componentExpected = expectedLines.filter((e) => e.role !== "subtotal");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A 429 is a transient account-level condition, not a regression in the
// extraction itself -- retry the same run a few times rather than counting
// it as a failure.
async function extractWithRateLimitRetry(images, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await extractBillFromImages(images);
    if (result.ok || result.kind !== "rate_limited") return result;
    const waitSeconds = result.retryAfterSeconds ?? 5;
    console.log(`  rate limited, waiting ${waitSeconds}s before retrying (attempt ${attempt}/${maxAttempts})...`);
    await sleep(waitSeconds * 1000);
  }
  return extractBillFromImages(images);
}

let allRunsPassed = true;

for (let run = 1; run <= RUNS; run++) {
  console.log(`\n=== Run ${run}/${RUNS} ===`);
  const result = await extractWithRateLimitRetry([{ bytes, mimeType }]);

  if (!result.ok) {
    console.log(`FAIL: extraction did not succeed: ${JSON.stringify(result)}`);
    allRunsPassed = false;
    continue;
  }

  const lineItems = result.data.line_items;
  for (const expected of expectedLines) {
    const match = lineItems.find(
      (li) =>
        Math.abs(li.amount - expected.amount) <= EPSILON && (!expected.role || li.role === expected.role)
    );
    if (match) {
      console.log(`  PASS: ${expected.label} (${expected.amount}) -- found as "${match.label}" [${match.role}]`);
    } else {
      console.log(`  FAIL: ${expected.label} (${expected.amount}) -- not found in this run's line_items`);
      allRunsPassed = false;
    }
  }

  if (subtotalExpected) {
    const subtotalLine = lineItems.find((li) => li.role === "subtotal");
    const cutoffIndex = subtotalLine ? lineItems.indexOf(subtotalLine) : lineItems.length;
    const linesBeforeSubtotal = lineItems
      .slice(0, cutoffIndex)
      .filter((li) => li.role === "charge" || li.role === "tax" || li.role === "discount");

    for (const li of linesBeforeSubtotal) {
      const isExpected = componentExpected.some(
        (e) => Math.abs(li.amount - e.amount) <= EPSILON && (!e.role || li.role === e.role)
      );
      if (!isExpected) {
        console.log(`  FAIL: unexpected line before "${subtotalExpected.label}": "${li.label}" (${li.amount}) [${li.role}]`);
        allRunsPassed = false;
      }
    }

    const sumBeforeSubtotal = linesBeforeSubtotal.reduce(
      (s, li) => s + (li.role === "discount" ? -li.amount : li.amount),
      0
    );
    const gap = sumBeforeSubtotal - subtotalExpected.amount;
    if (Math.abs(gap) <= EPSILON) {
      console.log(`  PASS: lines before "${subtotalExpected.label}" sum to ${sumBeforeSubtotal.toFixed(2)}`);
    } else {
      console.log(
        `  FAIL: lines before "${subtotalExpected.label}" sum to ${sumBeforeSubtotal.toFixed(2)}, expected ${subtotalExpected.amount} (gap ${gap.toFixed(2)})`
      );
      allRunsPassed = false;
    }
  }
}

console.log(`\n${allRunsPassed ? "PASS" : "FAIL"}: all expected lines present in every run.`);
if (!allRunsPassed) process.exit(1);
