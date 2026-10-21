import assert from "node:assert/strict";
import {
  shouldResize,
  targetSize,
  isNetworkError,
  classifyUploadError,
  readIntoMemory,
  prepareUploadFile,
  RESIZE_FALLBACK_MAX_BYTES,
} from "./upload-image.ts";

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

// Error classification: any failure reading the picked file is
// "unreadable" -- even a TypeError, which would look like a network error
// if classified by shape alone. Only upload-phase network errors are "network".
{
  const domError = (name) => Object.assign(new Error("x"), { name });
  assert.equal(classifyUploadError("read", domError("NotReadableError")), "unreadable");
  assert.equal(classifyUploadError("read", domError("NotFoundError")), "unreadable");
  assert.equal(classifyUploadError("read", new TypeError("Failed to fetch")), "unreadable", "read phase wins over error shape");
  assert.equal(classifyUploadError("read", "anything"), "unreadable");
  assert.equal(classifyUploadError("upload", new TypeError("Failed to fetch")), "network");
  assert.equal(classifyUploadError("upload", { message: "Failed to fetch" }), "network");
  assert.equal(classifyUploadError("upload", { message: "The resource already exists" }), "other");
  assert.equal(classifyUploadError("upload", domError("NotReadableError")), "other");
  console.log("PASS: classifyUploadError -- read failures unreadable, upload network vs other");
}

// readIntoMemory: same name/type/bytes, detached from the original handle;
// a handle that throws on read propagates the error.
{
  const original = new File([new Uint8Array([1, 2, 3])], "bill.jpg", { type: "image/jpeg" });
  const copy = await readIntoMemory(original);
  assert.notEqual(copy, original);
  assert.equal(copy.name, "bill.jpg");
  assert.equal(copy.type, "image/jpeg");
  assert.deepEqual([...new Uint8Array(await copy.arrayBuffer())], [1, 2, 3]);

  const broken = { name: "x.jpg", type: "image/jpeg", arrayBuffer: () => Promise.reject(Object.assign(new Error("gone"), { name: "NotReadableError" })) };
  await assert.rejects(readIntoMemory(broken), { name: "NotReadableError" });
  console.log("PASS: readIntoMemory -- in-memory copy keeps name/type/bytes; unreadable handle throws");
}

// prepareUploadFile when resizing fails (no createImageBitmap in Node):
// the in-memory original is used if <= 10 MB, otherwise null.
{
  const small = new File([new Uint8Array(1000)], "a.jpg", { type: "image/jpeg" });
  assert.equal(await prepareUploadFile(small), small);
  const big = new File([new Uint8Array(RESIZE_FALLBACK_MAX_BYTES + 1)], "b.jpg", { type: "image/jpeg" });
  assert.equal(await prepareUploadFile(big), null);
  const bigPdf = new File([new Uint8Array(RESIZE_FALLBACK_MAX_BYTES + 1)], "c.pdf", { type: "application/pdf" });
  assert.equal(await prepareUploadFile(bigPdf), bigPdf, "PDFs are never resized or capped here");
  console.log("PASS: prepareUploadFile -- resize failure falls back to original under 10 MB, null above");
}
