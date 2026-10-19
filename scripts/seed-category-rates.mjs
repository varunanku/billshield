// Seeds public.category_rates from data/category-rates.csv -- rates are
// never invented in code; this only loads whatever you've filled in from
// the official CBIC GST rate schedule. Run with:
//   node --env-file=.env.local scripts/seed-category-rates.mjs [path/to/csv]
//
// A row with gst_rate_total left blank is still inserted (as a null-rate
// placeholder) so the category shows up, but lib/gst.ts's findMatchingRate
// ignores any row with a null rate -- fill it in and re-run this script
// once you have the real figure and its source_url.

import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const csvPath = process.argv[2] ?? "data/category-rates.csv";
if (!fs.existsSync(csvPath)) {
  console.error(`CSV not found: ${csvPath}`);
  process.exit(1);
}

const NUMERIC_COLUMNS = new Set(["gst_rate_total", "cgst", "sgst", "igst"]);

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map((c) => c.trim());
    const row = {};
    header.forEach((col, i) => {
      const raw = cells[i] ?? "";
      row[col] = raw === "" ? null : NUMERIC_COLUMNS.has(col) ? Number(raw) : raw;
    });
    return row;
  });
}

const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
if (rows.length === 0) {
  console.error("No data rows found in the CSV.");
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

// Reference data with no FK dependents -- a clean replace each run is
// simpler and safer than trying to upsert on a key that doesn't exist yet.
const { error: deleteError } = await admin.from("category_rates").delete().not("id", "is", null);
if (deleteError) {
  console.error("Couldn't clear existing category_rates:", deleteError.message);
  process.exit(1);
}

const { error: insertError, count } = await admin.from("category_rates").insert(rows, { count: "exact" });
if (insertError) {
  console.error("Insert failed:", insertError.message);
  process.exit(1);
}

const sourced = rows.filter((r) => r.gst_rate_total !== null).length;
console.log(`Seeded ${count ?? rows.length} row(s) from ${csvPath} (${sourced} with a sourced rate, ${rows.length - sourced} still TODO).`);
