import * as mupdf from "mupdf";

// PDF -> PNG pages, for feeding to a vision model that only accepts images.
//
// Uses `mupdf` (Artifex's official WASM bindings): pure WebAssembly, no
// native .node binary to match against the host's OS/architecture, so it
// runs the same in a Vercel serverless function (Node.js runtime) as it
// does locally. The usual node-canvas-based approach (pdfjs-dist + canvas)
// is the thing that tends to break on Vercel, because `canvas` needs a
// prebuilt native binary for the exact Lambda environment.
//
// Caps at `maxPages` (default 3, per CLAUDE.md scope) -- only the first N
// pages are rendered; `truncated` tells the caller whether to say so.

const RENDER_SCALE = 2.0; // ~144 DPI from a 72 DPI PDF page: legible for OCR without being huge.

export function pdfToPngImages(
  pdfBytes: Buffer,
  maxPages = 3
): { images: Buffer[]; totalPages: number; truncated: boolean } {
  const doc = mupdf.Document.openDocument(pdfBytes, "application/pdf");
  try {
    const totalPages = doc.countPages();
    const pagesToRender = Math.min(totalPages, maxPages);
    const images: Buffer[] = [];

    for (let i = 0; i < pagesToRender; i++) {
      const page = doc.loadPage(i);
      try {
        const pixmap = page.toPixmap(
          mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE),
          mupdf.ColorSpace.DeviceRGB,
          false,
          true
        );
        try {
          images.push(Buffer.from(pixmap.asPNG()));
        } finally {
          pixmap.destroy();
        }
      } finally {
        page.destroy();
      }
    }

    return { images, totalPages, truncated: totalPages > maxPages };
  } finally {
    doc.destroy();
  }
}
