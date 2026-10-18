import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { pdfToPngImages } from "@/lib/pdf-to-images";
import { extractBillFromImages, type ExtractedBill } from "@/lib/groq";

export const maxDuration = 60; // vision call + PDF rendering can take a few seconds; lower this if your Vercel plan caps it.

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // matches Groq's own 20MB/request image limit
const MAX_PDF_PAGES = 3;

type ApiResponse =
  | { success: true; extraction: ExtractedBill; notice: string | null }
  | { success: false; reason: "bad_request" | "unauthorized" | "rate_limited" | "server_error"; message: string; notice?: string };

function json(body: ApiResponse, status: number) {
  return NextResponse.json(body, { status });
}

// Extraction only -- reads the bill and hands it back for the user to
// review and confirm. Nothing is stored or masked here; that happens at
// /api/bills/confirm, once the user has had a chance to fix anything the
// model got wrong (CLAUDE.md hard rule 3: mask before storing, not before
// showing the user their own bill back to them).
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return json({ success: false, reason: "unauthorized", message: "Please sign in first." }, 401);
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !(file instanceof File)) {
    return json({ success: false, reason: "bad_request", message: "No file was uploaded." }, 400);
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return json(
      { success: false, reason: "bad_request", message: "That file is too large (max 20MB)." },
      400
    );
  }

  const isPdf = file.type === "application/pdf";
  const isImage = file.type.startsWith("image/");
  if (!isPdf && !isImage) {
    return json(
      { success: false, reason: "bad_request", message: "Please upload an image (PNG/JPEG) or a PDF." },
      400
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());

  let images: Buffer[];
  let notice: string | null = null;

  if (isPdf) {
    let rendered;
    try {
      rendered = pdfToPngImages(bytes, MAX_PDF_PAGES);
    } catch {
      return json(
        { success: false, reason: "bad_request", message: "Couldn't open that PDF. Try a different file." },
        400
      );
    }
    images = rendered.images;
    if (rendered.truncated) {
      notice = `This PDF has ${rendered.totalPages} pages; only the first ${MAX_PDF_PAGES} were read.`;
    }
  } else {
    images = [bytes];
  }

  const extraction = await extractBillFromImages(images);

  if (!extraction.ok && extraction.kind === "rate_limited") {
    const wait = extraction.retryAfterSeconds;
    return json(
      {
        success: false,
        reason: "rate_limited",
        message: wait
          ? `We're getting a lot of requests right now. Please wait about ${Math.ceil(wait)}s and try again.`
          : "We're getting a lot of requests right now. Please wait a few seconds and try again.",
        notice: notice ?? undefined,
      },
      429
    );
  }

  if (!extraction.ok) {
    console.error("Groq extraction failed:", extraction.detail);
    return json(
      {
        success: false,
        reason: "server_error",
        message: "Something went wrong reading this bill. Please try again.",
        notice: notice ?? undefined,
      },
      500
    );
  }

  return json({ success: true, extraction: extraction.data, notice }, 200);
}
