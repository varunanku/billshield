import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isValidOwnedPath } from "@/lib/storage-paths";
import { pdfToPngImages } from "@/lib/pdf-to-images";
import { extractBillFromImages, type ExtractedBill, type ImageInput } from "@/lib/groq";

export const maxDuration = 60; // vision call + PDF rendering can take a few seconds; lower this if your Vercel plan caps it.

const MAX_FILE_BYTES = 20 * 1024 * 1024; // matches Groq's own 20MB/request image limit
const MAX_PDF_PAGES = 3;

type ApiResponse =
  | { success: true; extraction: ExtractedBill; notice: string | null; path: string }
  | { success: false; reason: "bad_request" | "unauthorized" | "rate_limited" | "server_error"; message: string; notice?: string };

function json(body: ApiResponse, status: number) {
  return NextResponse.json(body, { status });
}

// Extraction only -- the file is already in the private bills bucket (the
// browser uploads straight there, since Vercel's serverless functions cap
// request bodies at 4.5MB and real phone photos routinely exceed that).
// This route just reads it back with the service role (which bypasses
// storage RLS, so `path` ownership has to be checked here explicitly) and
// hands the extraction back for the user to review and confirm. Nothing is
// written to the DB or masked here; that happens at /api/bills/confirm.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return json({ success: false, reason: "unauthorized", message: "Please sign in first." }, 401);
  }

  const body = await request.json().catch(() => null);
  const path = body?.path;
  if (typeof path !== "string" || !path) {
    return json({ success: false, reason: "bad_request", message: "No uploaded file path was given." }, 400);
  }

  // The service role client below bypasses storage RLS entirely, so this
  // ownership check is standing in for what RLS would otherwise enforce --
  // without it, a client could pass another user's path and we'd happily
  // read their file. user.id comes from the session above, never from the
  // request body.
  if (!isValidOwnedPath(path, user.id)) {
    return json({ success: false, reason: "unauthorized", message: "That file doesn't belong to you." }, 401);
  }

  const admin = createAdminClient();
  const { data: fileBlob, error: downloadError } = await admin.storage.from("bills").download(path);
  if (downloadError || !fileBlob) {
    console.error("Storage download failed:", downloadError);
    return json(
      { success: false, reason: "bad_request", message: "Couldn't find that uploaded file. Please upload it again." },
      400
    );
  }

  if (fileBlob.size > MAX_FILE_BYTES) {
    return json({ success: false, reason: "bad_request", message: "That file is too large (max 20MB)." }, 400);
  }

  // Trust the blob's stored content-type (set by the browser at upload
  // time) over the path extension, falling back to the extension only if
  // the content-type came back generic/missing.
  let mimeType = fileBlob.type;
  const isPdfByPath = path.toLowerCase().endsWith(".pdf");
  if (!mimeType || mimeType === "application/octet-stream") {
    mimeType = isPdfByPath ? "application/pdf" : "image/jpeg";
  }
  const isPdf = mimeType === "application/pdf" || isPdfByPath;
  const isImage = mimeType.startsWith("image/");
  if (!isPdf && !isImage) {
    return json({ success: false, reason: "bad_request", message: "Please upload an image (PNG/JPEG) or a PDF." }, 400);
  }

  const bytes = Buffer.from(await fileBlob.arrayBuffer());

  let images: ImageInput[];
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
    images = rendered.images.map((png) => ({ bytes: png, mimeType: "image/png" }));
    if (rendered.truncated) {
      notice = `This PDF has ${rendered.totalPages} pages; only the first ${MAX_PDF_PAGES} were read.`;
    }
  } else {
    images = [{ bytes, mimeType }];
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

  return json({ success: true, extraction: extraction.data, notice, path }, 200);
}
