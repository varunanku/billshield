import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { pdfToPngImages } from "@/lib/pdf-to-images";
import { extractBillFromImages } from "@/lib/groq";
import { maskPII } from "@/lib/mask";

// Route Handlers default to the Node.js runtime (what mupdf needs for its
// WASM + Buffer usage) unless `runtime: "edge"` is set, which it isn't.
export const maxDuration = 60; // vision call + PDF rendering can take a few seconds; lower this if your Vercel plan caps it.

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // matches Groq's own 20MB/request image limit
const MAX_PDF_PAGES = 3;
const SUM_EPSILON = 0.01; // floating-point rounding only, not a business tolerance

type ApiResponse =
  | { success: true; bill: { id: string; provider: string; billDate: string; total: number; lineItems: { label: string; amount: number }[] }; notice: string | null }
  | { success: false; reason: "bad_request" | "unauthorized" | "rate_limited" | "unreliable" | "server_error"; message: string; notice?: string };

function json(body: ApiResponse, status: number) {
  return NextResponse.json(body, { status });
}

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

  const { provider, bill_date, total, line_items } = extraction.data;

  const sum = line_items.reduce((s, li) => s + li.amount, 0);
  const validDate = typeof bill_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(bill_date);
  const reliable =
    typeof total === "number" &&
    line_items.length > 0 &&
    Math.abs(sum - total) <= SUM_EPSILON &&
    typeof provider === "string" &&
    provider.trim().length > 0 &&
    validDate;

  if (!reliable) {
    return json(
      {
        success: false,
        reason: "unreliable",
        message: "Couldn't read this bill reliably -- the lines don't add up to the printed total, or a required field wasn't legible. Try a clearer photo or a different file.",
        notice: notice ?? undefined,
      },
      200
    );
  }

  const maskedProvider = maskPII(provider as string);
  const maskedLineItems = line_items.map((li) => ({ label: maskPII(li.label), amount: li.amount }));

  const ext = isPdf ? "pdf" : file.type.split("/")[1] || "bin";
  const path = `${user.id}/${crypto.randomUUID()}.${ext}`;

  const { error: uploadError } = await supabase.storage.from("bills").upload(path, bytes, {
    contentType: file.type,
    upsert: false,
  });
  if (uploadError) {
    console.error("Storage upload failed:", uploadError);
    return json(
      { success: false, reason: "server_error", message: "Couldn't save the file. Please try again." },
      500
    );
  }

  const { data: bill, error: billError } = await supabase
    .from("bills")
    .insert({
      user_id: user.id,
      provider_name: maskedProvider,
      bill_date: bill_date as string,
      total_amount: total as number,
      file_path: path,
    })
    .select()
    .single();

  if (billError || !bill) {
    console.error("Bill insert failed:", billError);
    return json(
      { success: false, reason: "server_error", message: "Couldn't save this bill. Please try again." },
      500
    );
  }

  const { error: lineItemsError } = await supabase.from("line_items").insert(
    maskedLineItems.map((li, index) => ({
      bill_id: bill.id,
      line_order: index + 1,
      label: li.label,
      amount: li.amount,
    }))
  );

  if (lineItemsError) {
    console.error("Line items insert failed:", lineItemsError);
    return json(
      { success: false, reason: "server_error", message: "Couldn't save this bill's line items. Please try again." },
      500
    );
  }

  return json(
    {
      success: true,
      bill: {
        id: bill.id,
        provider: maskedProvider,
        billDate: bill_date as string,
        total: total as number,
        lineItems: maskedLineItems,
      },
      notice,
    },
    200
  );
}
