// Rows from public.provider_monthly_timeline (migration 0015) and the text
// built from them for the chat and My bills. Pure, no network. Every
// figure -- change, averages, min/max, above/below -- comes from the view;
// this file only formats them and attaches each row's source label.

export type TimelineRow = {
  provider_key: string;
  provider_name: string;
  month: string; // YYYY-MM-DD, first of the month
  source: "checked" | "printed";
  amount: number | null;
  units: number | null;
  amount_paid: number | null;
  period_label: string | null;
  source_bill_id: string;
  source_bill_date: string;
  prev_month: string | null;
  prev_amount: number | null;
  change_rs: number | null;
  change_pct: number | null;
  avg_3m: number | null;
  avg_6m: number | null;
  months_in_6m: number;
  pct_vs_avg_6m: number | null;
  min_to_date: number | null;
  max_to_date: number | null;
  vs_avg_3m: "above" | "below" | "equal" | null;
};

export const TIMELINE_COLUMNS =
  "provider_key, provider_name, month, source, amount, units, amount_paid, period_label, source_bill_id, " +
  "source_bill_date, prev_month, prev_amount, change_rs, change_pct, avg_3m, avg_6m, months_in_6m, " +
  "pct_vs_avg_6m, min_to_date, max_to_date, vs_avg_3m";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// PostgREST returns numeric columns as numbers or strings and dates as
// strings; a direct Postgres driver returns Date objects -- accept both.
export function toTimelineRow(raw: Record<string, unknown>): TimelineRow {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const date = (v: unknown) =>
    v === null || v === undefined ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
  return {
    provider_key: String(raw.provider_key ?? ""),
    provider_name: String(raw.provider_name ?? ""),
    month: date(raw.month) ?? "",
    source: raw.source === "printed" ? "printed" : "checked",
    amount: num(raw.amount),
    units: num(raw.units),
    amount_paid: num(raw.amount_paid),
    period_label: raw.period_label === null || raw.period_label === undefined ? null : String(raw.period_label),
    source_bill_id: String(raw.source_bill_id ?? ""),
    source_bill_date: date(raw.source_bill_date) ?? "",
    prev_month: date(raw.prev_month),
    prev_amount: num(raw.prev_amount),
    change_rs: num(raw.change_rs),
    change_pct: num(raw.change_pct),
    avg_3m: num(raw.avg_3m),
    avg_6m: num(raw.avg_6m),
    months_in_6m: Number(raw.months_in_6m ?? 0),
    pct_vs_avg_6m: num(raw.pct_vs_avg_6m),
    min_to_date: num(raw.min_to_date),
    max_to_date: num(raw.max_to_date),
    vs_avg_3m: raw.vs_avg_3m === "above" || raw.vs_avg_3m === "below" || raw.vs_avg_3m === "equal" ? raw.vs_avg_3m : null,
  };
}

export function monthName(isoDate: string): string {
  return `${MONTH_NAMES[Number(isoDate.slice(5, 7)) - 1] ?? "?"} ${isoDate.slice(0, 4)}`;
}

// "(as printed on your March bill, not checked by BillShield)"
export function sourceLabel(row: TimelineRow): string {
  if (row.source === "checked") return "(from a bill you saved, checked by BillShield)";
  const billMonth = MONTH_NAMES[Number(row.source_bill_date.slice(5, 7)) - 1] ?? "earlier";
  return `(as printed on your ${billMonth} bill, not checked by BillShield)`;
}

const rs = (n: number) => `Rs ${n.toFixed(2)}`;
const signed = (n: number, suffix = "") => `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(2)}${suffix}`;

// One fact line for the chat: the month's own figures, its source label,
// and the view's computed comparisons -- nothing computed here.
export function describeTimelineRow(row: TimelineRow): string {
  const own = [
    row.amount !== null ? rs(row.amount) : null,
    row.units !== null ? `${row.units} units` : null,
    row.amount_paid !== null ? `paid ${rs(row.amount_paid)}` : null,
  ].filter(Boolean);
  const facts: string[] = [];
  if (row.change_rs !== null && row.prev_month) {
    facts.push(
      `vs ${monthName(row.prev_month)}: ${signed(row.change_rs).replace(/^([+-])/, "$1Rs ")}` +
        (row.change_pct !== null ? ` (${signed(row.change_pct, "%")})` : "")
    );
  }
  if (row.avg_3m !== null) facts.push(`3-month average ${rs(row.avg_3m)}${row.vs_avg_3m ? ` (this month is ${row.vs_avg_3m === "equal" ? "equal to" : row.vs_avg_3m} it)` : ""}`);
  if (row.avg_6m !== null) facts.push(`6-month average ${rs(row.avg_6m)} over ${row.months_in_6m} month(s)`);
  if (row.min_to_date !== null && row.max_to_date !== null) facts.push(`lowest so far ${rs(row.min_to_date)}, highest ${rs(row.max_to_date)}`);
  return `- ${monthName(row.month)}: ${own.join(", ") || "no amount printed"} ${sourceLabel(row)}${facts.length ? `; ${facts.join("; ")}` : ""}`;
}

// The chat's past-months block: earlier months, then this bill's own row
// (where the view says how it compares with the averages).
export function describeTimeline(past: TimelineRow[], current: TimelineRow | null): string {
  if (past.length === 0 && !current) return "none on record";
  const lines = past.map(describeTimelineRow);
  if (past.length === 0) lines.push("(no earlier months on record)");
  if (current) {
    lines.push(`This bill's own month: ${describeTimelineRow(current).slice(2)}`);
    if (current.pct_vs_avg_6m !== null) {
      lines.push(
        `This bill is ${Math.abs(current.pct_vs_avg_6m).toFixed(2)}% ${current.pct_vs_avg_6m >= 0 ? "above" : "below"} its 6-month average (computed by BillShield).`
      );
    }
  }
  return lines.join("\n");
}

const inr = (n: number) => Math.round(n).toLocaleString("en-IN");

// My bills: one plain line for a provider with 3+ months in the timeline.
// "Last 6 months: average Rs 9,840; this bill is 12% above average."
export function timelineSummary(rows: TimelineRow[]): string | null {
  if (rows.length < 3) return null;
  const latest = [...rows].sort((a, b) => a.month.localeCompare(b.month))[rows.length - 1];
  if (latest.avg_6m === null || latest.pct_vs_avg_6m === null) return null;
  const subject = latest.source === "checked" ? "this bill" : "the latest month";
  const pct = Math.round(Math.abs(latest.pct_vs_avg_6m));
  const comparison =
    pct === 0 ? `${subject} is about the same as average` : `${subject} is ${pct}% ${latest.pct_vs_avg_6m > 0 ? "above" : "below"} average`;
  return `Last ${latest.months_in_6m} months: average Rs ${inr(latest.avg_6m)}; ${comparison}.`;
}
