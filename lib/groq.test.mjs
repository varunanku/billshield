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
