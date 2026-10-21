import assert from "node:assert/strict";
import { shouldResize, targetSize, isNetworkError } from "./upload-image.ts";

const MB = 1024 * 1024;

// Size threshold: strictly over 1.5 MB.
assert.equal(shouldResize("image/jpeg", 1.5 * MB, 1000, 800), false, "exactly 1.5 MB, small dims: no resize");
assert.equal(shouldResize("image/jpeg", 1.5 * MB + 1, 1000, 800), true, "just over 1.5 MB: resize");

// Dimension threshold: long edge strictly over 2000 px.
assert.equal(shouldResize("image/png", 200_000, 2000, 1500), false, "exactly 2000 px wide: no resize");
assert.equal(shouldResize("image/png", 200_000, 2001, 1500), true, "2001 px wide: resize");
assert.equal(shouldResize("image/webp", 200_000, 1500, 4000), true, "tall portrait photo: resize");

// Type gate: PDFs and anything else untouched, regardless of size.
assert.equal(shouldResize("application/pdf", 10 * MB, 5000, 5000), false, "PDF never resized");
assert.equal(shouldResize("image/gif", 10 * MB, 5000, 5000), false, "unsupported type never resized");
assert.equal(shouldResize("IMAGE/JPEG", 10 * MB, 100, 100), true, "type check is case-insensitive");

// Target size: long edge to 2000, aspect kept, never upscaled.
assert.deepEqual(targetSize(4000, 3000), { width: 2000, height: 1500 });
assert.deepEqual(targetSize(3000, 4000), { width: 1500, height: 2000 });
assert.deepEqual(targetSize(1200, 900), { width: 1200, height: 900 });

// Network error detection.
assert.equal(isNetworkError(new TypeError("Failed to fetch")), true);
assert.equal(isNetworkError({ message: "Failed to fetch" }), true);
assert.equal(isNetworkError({ message: "x", originalError: new TypeError("y") }), true);
assert.equal(isNetworkError({ message: "The resource already exists" }), false);
assert.equal(isNetworkError(null), false);

console.log("PASS: upload-image -- resize thresholds, target size, network error detection");
