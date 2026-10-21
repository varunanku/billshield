// Browser-side shrinking of big phone photos before they go to storage.
// Large uploads over a flaky mobile connection were the main cause of
// "Failed to fetch" during upload. PDFs are never touched.

export const RESIZE_MAX_BYTES = 1.5 * 1024 * 1024;
export const RESIZE_MAX_EDGE = 2000;
export const RESIZE_JPEG_QUALITY = 0.85;

export const RESIZE_FALLBACK_MAX_BYTES = 10 * 1024 * 1024;

const RESIZABLE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export const FILE_UNREADABLE_MESSAGE =
  "Couldn't open this photo on your phone. If it's in Google Photos, download it to your device first, or pick it using Files instead of Photos. A screenshot of the bill also works.";
export const UPLOAD_NETWORK_MESSAGE =
  "Upload failed — your connection may have dropped. Try again, or upload a screenshot of the bill instead.";
export const FILE_TOO_LARGE_MESSAGE =
  "This photo is too large to upload as it is. Please upload a screenshot of the bill instead.";

// Which message an upload-flow failure gets. Phase matters more than the
// error itself: ANY failure while reading the picked file is "unreadable"
// (Google Photos on Android hands out a cloud-backed handle that can throw
// NotReadableError/NotFoundError, or even a TypeError, once read); only a
// network-shaped failure during the storage upload is "network".
export type UploadErrorKind = "unreadable" | "network" | "other";

export function classifyUploadError(phase: "read" | "upload", err: unknown): UploadErrorKind {
  if (phase === "read") return "unreadable";
  return isNetworkError(err) ? "network" : "other";
}

// Read the picked file into memory right away, while the handle is still
// valid, and return an in-memory copy with the same name and type. Callers
// use this copy from then on, never the original handle. Throws if the
// file can't be read.
export async function readIntoMemory(file: File): Promise<File> {
  const buffer = await file.arrayBuffer();
  return new File([buffer], file.name, { type: file.type, lastModified: file.lastModified });
}

// Pure decision: resize when the image is over 1.5 MB or its long edge is
// over 2000 px. Long edge rather than width alone, so a tall portrait
// photo (e.g. 1500x4000) is caught too.
export function shouldResize(type: string, bytes: number, width: number, height: number): boolean {
  if (!RESIZABLE_TYPES.includes(type.toLowerCase())) return false;
  return bytes > RESIZE_MAX_BYTES || Math.max(width, height) > RESIZE_MAX_EDGE;
}

// Scale so the long edge is at most RESIZE_MAX_EDGE; never upscale.
export function targetSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, RESIZE_MAX_EDGE / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

// Supabase storage reports a dropped connection either by throwing a
// TypeError or by returning an error whose message is "Failed to fetch"
// (sometimes wrapping the TypeError as originalError).
export function isNetworkError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof TypeError) return true;
  const e = err as { message?: unknown; originalError?: unknown };
  if (e.originalError instanceof TypeError) return true;
  return typeof e.message === "string" && /failed to fetch|network ?error|load failed/i.test(e.message);
}

// Returns the file to upload: a re-encoded JPEG when shouldResize says so,
// otherwise the original. Any decode/encode failure falls back to the
// original file, as long as it's at most RESIZE_FALLBACK_MAX_BYTES --
// null means it's too big to send unresized.
export async function prepareUploadFile(file: File): Promise<File | null> {
  const fallback = file.size <= RESIZE_FALLBACK_MAX_BYTES ? file : null;
  if (!RESIZABLE_TYPES.includes(file.type.toLowerCase())) return file;
  try {
    const bitmap = await createImageBitmap(file);
    if (!shouldResize(file.type, file.size, bitmap.width, bitmap.height)) {
      bitmap.close();
      return file;
    }
    const { width, height } = targetSize(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return fallback;
    // White background so transparent PNG areas don't turn black in JPEG.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", RESIZE_JPEG_QUALITY));
    if (!blob) return fallback;
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg" });
  } catch {
    return fallback;
  }
}
