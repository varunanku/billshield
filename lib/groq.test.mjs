// Regression test for the real-mime-type bug (every image used to be
// labelled image/png in the data URL regardless of its actual type). No
// network call -- buildImageContent is pure.
import assert from "node:assert/strict";
import { buildImageContent, coerceExtractedBill } from "./groq.ts";

const jpegBytes = Buffer.from("fake-jpeg-bytes");
const pngBytes = Buffer.from("fake-png-bytes");
const webpBytes = Buffer.from("fake-webp-bytes");

const content = buildImageContent([
  { bytes: jpegBytes, mimeType: "image/jpeg" },
  { bytes: pngBytes, mimeType: "image/png" },
  { bytes: webpBytes, mimeType: "image/webp" },
]);

assert.equal(content[0].type, "text", "first part should be the prompt text");

const jpegPart = content[1];
assert.equal(jpegPart.type, "image_url");
assert.equal(
  jpegPart.image_url.url,
  `data:image/jpeg;base64,${jpegBytes.toString("base64")}`,
  "a JPEG image must be labelled image/jpeg, not hardcoded to png"
);

const pngPart = content[2];
assert.equal(pngPart.image_url.url, `data:image/png;base64,${pngBytes.toString("base64")}`);

const webpPart = content[3];
assert.equal(
  webpPart.image_url.url,
  `data:image/webp;base64,${webpBytes.toString("base64")}`,
  "a WEBP image must be labelled image/webp"
);

console.log("PASS: buildImageContent uses each image's own real mime type (jpeg, png, webp)");

// Case: coerceExtractedBill parses the brand/legal-name pair -- the
// Overleaf test from item 8: brand "Overleaf", legal "Digital Science UK
// Limited".
{
  const parsed = coerceExtractedBill({
    provider: "Overleaf",
    provider_legal_name: "Digital Science UK Limited",
    bill_date: "2026-06-22",
    total: 653.31,
    line_items: [],
  });
  assert.equal(parsed.provider, "Overleaf");
  assert.equal(parsed.provider_legal_name, "Digital Science UK Limited");
  console.log("PASS: coerceExtractedBill parses provider_legal_name alongside the brand");
}

// Case: provider_legal_name defaults to null when absent -- most bills
// have no separate legal name printed.
{
  const parsed = coerceExtractedBill({ provider: "Airtel", bill_date: "2026-01-01", total: 100, line_items: [] });
  assert.equal(parsed.provider_legal_name, null);
  console.log("PASS: coerceExtractedBill defaults provider_legal_name to null when absent");
}

// Case: printed_hsn_codes parses an array of printed codes, dropping any
// non-string entry rather than failing the whole extraction over it.
{
  const parsed = coerceExtractedBill({
    provider: "BigBasket",
    bill_date: "2026-01-01",
    total: 100,
    line_items: [],
    printed_hsn_codes: ["21069099", 12345, "1006"],
  });
  assert.deepEqual(parsed.printed_hsn_codes, ["21069099", "1006"]);
  console.log("PASS: coerceExtractedBill parses printed_hsn_codes, dropping non-string entries");
}

// Case: no printed_hsn_codes field at all (most bills print no HSN/SAC
// code) -- defaults to an empty array, never null/undefined.
{
  const parsed = coerceExtractedBill({ provider: "HP Gas", bill_date: "2026-01-01", total: 971, line_items: [] });
  assert.deepEqual(parsed.printed_hsn_codes, []);
  console.log("PASS: coerceExtractedBill defaults printed_hsn_codes to [] when absent");
}
