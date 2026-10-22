// provider_monthly_timeline (migration 0015), run for real in PGlite --
// Postgres compiled to WebAssembly, in-process, no network. The migration
// file itself is executed on top of minimal stand-ins for the tables it
// reads, so this tests the actual SQL that ships.
// Run with: node lib/timeline.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const migration = readFileSync(new URL("../supabase/migrations/0015_provider_monthly_timeline.sql", import.meta.url), "utf8");

const db = new PGlite();
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.bills (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    provider_name text not null,
    bill_date date not null,
    billing_period_end date,
    total_amount numeric(12,2) not null,
    created_at timestamptz not null default now()
  );
  create table public.bill_metrics (
    id uuid primary key default gen_random_uuid(),
    bill_id uuid not null, metric text not null, value numeric(12,2) not null,
    created_at timestamptz not null default now()
  );
  create table public.bill_printed_history (
    id uuid primary key default gen_random_uuid(),
    bill_id uuid not null, user_id uuid not null, period_label text not null, period_start date,
    amount numeric(12,2), units numeric(12,2), amount_paid numeric(12,2), paid_on date,
    created_at timestamptz default now()
  );
`);
await db.exec(migration);

const USER = "11111111-1111-1111-1111-111111111111";

async function addBill({ provider, billDate, periodEnd, total, reconciled = null, units = null }) {
  const { rows } = await db.query(
    `insert into public.bills (user_id, provider_name, bill_date, billing_period_end, total_amount, reconciled_total)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [USER, provider, billDate, periodEnd, total, reconciled]
  );
  const id = rows[0].id;
  if (units !== null) {
    await db.query(`insert into public.bill_metrics (bill_id, metric, value) values ($1, 'units_consumed', $2)`, [id, units]);
  }
  return id;
}
async function addPrinted(billId, label, periodStart, amount, units = null) {
  await db.query(
    `insert into public.bill_printed_history (bill_id, user_id, period_label, period_start, amount, units) values ($1, $2, $3, $4, $5, $6)`,
    [billId, USER, label, periodStart, amount, units]
  );
}
async function timeline(key) {
  const { rows } = await db.query(
    `select * from public.provider_monthly_timeline where provider_key = $1 order by month`,
    [key]
  );
  return rows;
}
const paise = (v) => (v === null ? null : Math.round(Number(v) * 100));
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d);

// --- provider_key ------------------------------------------------------
{
  const key = async (name) => (await db.query(`select public.provider_key($1) as k`, [name])).rows[0].k;
  assert.equal(await key("TATA POWER DELHI DISTRIBUTION LIMITED"), "tata power");
  assert.equal(await key("Tata Power-DDL"), "tata power");
  assert.equal(await key("Tata Power Delhi Distribution Ltd."), "tata power");
  assert.equal(await key("  tata   power ddl "), "tata power");
  assert.equal(await key("BSES Rajdhani Power Ltd"), "bses rajdhani");
  assert.notEqual(await key("BSES Rajdhani Power Ltd"), await key("BSES Yamuna Power Ltd"));
  assert.equal(await key("Airtel"), "airtel");
  assert.equal(await key("The Pvt. Ltd."), null, "nothing left -> null, never an empty key");
  console.log("PASS: (c) provider_key -- 'Tata Power-DDL' and 'TATA POWER DELHI DISTRIBUTION LIMITED' share a key");
}

// --- (a) 4 confirmed monthly bills, each printing its 4 previous months --
// Base amount per month. Printed copies of a month carry +0.01 per later
// source bill, so we can see which printing won; printed copies of a month
// that also has a real bill carry +100, so we can see the real bill won.
const MONTHS = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"];
const BASE = {
  "2026-02": 7420.1, "2026-03": 7980.55, "2026-04": 9120.0, "2026-05": 10450.35,
  "2026-06": 9874.2, "2026-07": 10113.19, "2026-08": 11020.75, "2026-09": 9632.88,
};
const NAMES = ["TATA POWER DELHI DISTRIBUTION LIMITED", "Tata Power-DDL", "Tata Power Delhi Distribution Ltd.", "tata power ddl"];
const CHECKED = ["2026-06", "2026-07", "2026-08", "2026-09"];

for (let i = 0; i < CHECKED.length; i++) {
  const month = CHECKED[i];
  // Month 6 uses reconciled_total (it differs from the printed total) to
  // prove the view prefers it.
  const billId = await addBill({
    provider: NAMES[i],
    billDate: `${month}-22`,
    periodEnd: `${month}-28`,
    total: i === 0 ? BASE[month] + 0.4 : BASE[month],
    reconciled: i === 0 ? BASE[month] : null,
    units: 1000 + i,
  });
  const idx = MONTHS.indexOf(month);
  for (const past of MONTHS.slice(idx - 4, idx)) {
    const amount = CHECKED.includes(past) ? BASE[past] + 100 : Math.round((BASE[past] + 0.01 * i) * 100) / 100;
    await addPrinted(billId, past, `${past}-01`, amount);
  }
}

const rows = await timeline("tata power");
{
  assert.deepEqual(rows.map((r) => iso(r.month).slice(0, 7)), MONTHS, "8 distinct months, oldest first");
  assert.equal(new Set(rows.map((r) => iso(r.month))).size, 8, "no duplicate months");
  assert.deepEqual(rows.map((r) => r.source), ["printed", "printed", "printed", "printed", "checked", "checked", "checked", "checked"]);
  for (const r of rows.filter((r) => r.source === "checked")) {
    assert.equal(paise(r.amount), paise(BASE[iso(r.month).slice(0, 7)]), "checked row wins, using the reconciled total");
  }
  // Latest printing wins: Feb only printed by the June bill (+0.00); March
  // last printed by July (+0.01); April by August (+0.02); May by September (+0.03).
  assert.deepEqual(rows.slice(0, 4).map((r) => paise(r.amount)), [742010, 798056, 912002, 1045038]);
  assert.equal(iso(rows[3].source_bill_date), "2026-09-22", "May came from the most recent bill that printed it");
  assert.equal(rows[3].period_label, "2026-05");
  assert.equal(Number(rows[4].units), 1000, "units from bill_metrics on checked rows");
  console.log("PASS: (a) 4 bills x 4 printed months -> 8 distinct months, checked wins, newest printing wins");
}

// --- (b) month-over-month and rolling figures, to the paisa ---------------
{
  // Reference in integer paise. Calendar windows: 3m = this month and the 2
  // before it; 6m = this and the 5 before (all 8 months here are present).
  const amounts = rows.map((r) => paise(r.amount));
  const roundHalfAway = (x) => Math.sign(x) * Math.round(Math.abs(x));
  amounts.forEach((a, i) => {
    const r = rows[i];
    const prev = i > 0 ? amounts[i - 1] : null;
    assert.equal(paise(r.prev_amount), prev);
    assert.equal(paise(r.change_rs), prev === null ? null : a - prev, `change_rs ${iso(r.month)}`);
    const pct = prev === null ? null : roundHalfAway(((a - prev) / prev) * 10000) / 100;
    assert.equal(r.change_pct === null ? null : Number(r.change_pct), pct, `change_pct ${iso(r.month)}`);
    const w3 = amounts.slice(Math.max(0, i - 2), i + 1);
    const w6 = amounts.slice(Math.max(0, i - 5), i + 1);
    assert.equal(paise(r.avg_3m), roundHalfAway(w3.reduce((s, v) => s + v, 0) / w3.length), `avg_3m ${iso(r.month)}`);
    assert.equal(paise(r.avg_6m), roundHalfAway(w6.reduce((s, v) => s + v, 0) / w6.length), `avg_6m ${iso(r.month)}`);
    assert.equal(Number(r.months_in_6m), w6.length);
    assert.equal(paise(r.min_to_date), Math.min(...amounts.slice(0, i + 1)));
    assert.equal(paise(r.max_to_date), Math.max(...amounts.slice(0, i + 1)));
    const avg3 = w3.reduce((s, v) => s + v, 0) / w3.length;
    assert.equal(r.vs_avg_3m, a > avg3 ? "above" : a < avg3 ? "below" : "equal");
  });
  // Spot-check by hand: Sep 9632.88 vs Aug 11020.75 = -1387.87 (-12.59%).
  const sep = rows[7];
  assert.equal(Number(sep.change_rs), -1387.87);
  assert.equal(Number(sep.change_pct), -12.59);
  // 3-month average Jul-Sep: (10113.19 + 11020.75 + 9632.88) / 3 = 10255.606... -> 10255.61
  assert.equal(Number(sep.avg_3m), 10255.61);
  assert.equal(sep.vs_avg_3m, "below");
  console.log("PASS: (b) change in Rs and %, 3/6-month averages, min/max, above/below -- correct to the paisa");
}

// --- (d) a gap month produces no row ----------------------------------------
{
  await addBill({ provider: "Delhi Jal Board", billDate: "2026-01-10", periodEnd: "2026-01-31", total: 970.0 });
  await addBill({ provider: "DELHI JAL BOARD", billDate: "2026-03-10", periodEnd: "2026-03-31", total: 1018.0 });
  const djb = await timeline("delhi jal");
  assert.deepEqual(djb.map((r) => iso(r.month)), ["2026-01-01", "2026-03-01"], "no February row");
  assert.ok(!djb.some((r) => Number(r.amount) === 0), "never a zero row");
  const mar = djb[1];
  assert.equal(iso(mar.prev_month), "2026-01-01", "previous available month, labelled by its month");
  assert.equal(Number(mar.change_rs), 48.0);
  assert.equal(Number(mar.avg_3m), 994.0, "Jan is inside Mar's 3-month window; the missing Feb isn't counted as 0");
  assert.equal(Number(mar.months_in_6m), 2);
  console.log("PASS: (d) gap month -> no row, no zero; averages count only months with data");
}

// Bills whose provider is unknown never form a timeline.
{
  await addBill({ provider: "Unknown provider", billDate: "2026-05-01", periodEnd: null, total: 10 });
  assert.equal((await timeline("unknown provider")).length, 0);
  console.log("PASS: 'Unknown provider' bills are left out");
}

// The text the chat and My bills build from real view output: every
// printed month carries its source bill's label, and the summary quotes
// the view's own 6-month average.
{
  const { toTimelineRow, describeTimeline, timelineSummary } = await import("./timeline.ts");
  const real = (await timeline("tata power")).map(toTimelineRow);
  const current = real[real.length - 1];
  const text = describeTimeline(real.slice(0, -1), current);
  assert.ok(text.includes("- May 2026: Rs 10450.38 (as printed on your September bill, not checked by BillShield)"));
  assert.ok(text.includes("- February 2026: Rs 7420.10 (as printed on your June bill, not checked by BillShield)"));
  assert.ok(text.includes("- June 2026: Rs 9874.20, 1000 units (from a bill you saved, checked by BillShield)"));
  assert.ok(text.includes("This bill's own month: September 2026: Rs 9632.88"));
  // 6-month window for September = April..September (6 months with data).
  const avg6 = (912002 + 1045038 + 987420 + 1011319 + 1102075 + 963288) / 6 / 100;
  assert.equal(current.avg_6m, Math.round(avg6 * 100) / 100);
  const pct = Math.round(Math.abs(current.pct_vs_avg_6m));
  assert.equal(
    timelineSummary(real),
    `Last 6 months: average Rs ${Math.round(current.avg_6m).toLocaleString("en-IN")}; this bill is ${pct}% below average.`
  );
  console.log(`PASS: chat/My bills text from real view rows -- labels intact; "${timelineSummary(real)}"`);
}

// The migration is idempotent: running it again works and changes nothing.
{
  await db.exec(migration);
  assert.equal((await timeline("tata power")).length, 8);
  console.log("PASS: migration 0015 runs twice cleanly");
}

await db.close();
