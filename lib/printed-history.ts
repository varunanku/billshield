// Past months as printed on an electricity or water bill (amounts, units,
// payments). Pure, no network. These rows are context only: they never
// enter line items, the arithmetic checks or the verdict, and wherever
// they're shown or handed to the chat they're labelled as printed, not
// checked by BillShield.

export const HISTORY_CATEGORIES = ["electricity", "water"] as const;
const MAX_ROWS = 24;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type PrintedHistoryRow = {
  period_label: string;
  period_start: string | null; // YYYY-MM-DD, first of the month when known
  amount: number | null;
  units: number | null;
  amount_paid: number | null;
  paid_on: string | null; // YYYY-MM-DD
};

export function historyAllowedFor(category: string | null | undefined): boolean {
  return (HISTORY_CATEGORIES as readonly string[]).includes(category ?? "");
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function fullYear(y: string): number {
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

function firstOfMonth(year: number, month: number): string | null {
  if (month < 1 || month > 12 || year < 2000 || year > 2100) return null;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

// "Mar 2026", "March-26", "Mar'26", "03/2026", "3-26", "2026-03" -> "2026-03-01".
export function parsePeriodStart(label: string): string | null {
  const s = label.trim().toLowerCase();
  let m = s.match(/^([a-z]{3})[a-z]*[\s\-'’./,]*(\d{4}|\d{2})$/);
  if (m) {
    const month = MONTHS.indexOf(m[1]) + 1;
    return month > 0 ? firstOfMonth(fullYear(m[2]), month) : null;
  }
  m = s.match(/^(\d{1,2})[\s\-/.](\d{4}|\d{2})$/);
  if (m) return firstOfMonth(fullYear(m[2]), Number(m[1]));
  m = s.match(/^(\d{4})[\-/.](\d{1,2})$/);
  if (m) return firstOfMonth(Number(m[1]), Number(m[2]));
  return null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e9 ? v : null;
}

function isoDate(v: unknown): string | null {
  return typeof v === "string" && ISO_DATE.test(v) ? v : null;
}

// Whatever the AI returned -> clean rows, or [] for any category other
// than electricity/water. A row needs a label and at least one number.
// Duplicated labels keep the first; at most 24 rows.
export function normalisePrintedHistory(raw: unknown, category: string | null | undefined): PrintedHistoryRow[] {
  if (!historyAllowedFor(category) || !Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const rows: PrintedHistoryRow[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const label = typeof r.period_label === "string" ? r.period_label.trim().slice(0, 40) : "";
    if (!label || seen.has(label.toLowerCase())) continue;
    const amount = num(r.amount);
    const units = num(r.units);
    const amount_paid = num(r.amount_paid);
    if (amount === null && units === null && amount_paid === null) continue;
    const start = isoDate(r.period_start);
    seen.add(label.toLowerCase());
    rows.push({
      period_label: label,
      period_start: start ? `${start.slice(0, 7)}-01` : parsePeriodStart(label),
      amount,
      units,
      amount_paid,
      paid_on: isoDate(r.paid_on),
    });
    if (rows.length >= MAX_ROWS) break;
  }
  return rows;
}

// --- Month-over-month comparison --------------------------------------

export type CheckedMonth = { month: string; billDate: string; total: number; units: number | null };
export type PrintedMonth = PrintedHistoryRow & { sourceBillDate: string };

export type MonthEntry = {
  month: string; // YYYY-MM
  source: "checked" | "printed";
  amount: number | null;
  units: number | null;
  amountPaid: number | null;
  printedOn: string | null; // bill_date of the bill that printed it (printed rows only)
};

// The month a real bill is "for": its printed billing period if known,
// else its bill date.
export function monthOfBill(bill: { bill_date: string; billing_period_start?: string | null }): string {
  return (bill.billing_period_start ?? bill.bill_date).slice(0, 7);
}

// One entry per month, oldest first. A real checked bill always wins over
// a printed row for the same month; among printed rows for the same month
// (overlapping tables on consecutive bills) the one from the most recent
// bill wins. Printed rows with no known month are left out -- they can't
// be placed in a comparison.
export function mergeMonthlyHistory(checked: CheckedMonth[], printed: PrintedMonth[]): MonthEntry[] {
  // month -> the entry kept so far, plus the bill date it came from.
  const byMonth = new Map<string, { entry: MonthEntry; from: string }>();
  for (const p of printed) {
    if (!p.period_start) continue;
    const month = p.period_start.slice(0, 7);
    const kept = byMonth.get(month);
    if (kept && kept.from >= p.sourceBillDate) continue;
    byMonth.set(month, {
      entry: { month, source: "printed", amount: p.amount, units: p.units, amountPaid: p.amount_paid, printedOn: p.sourceBillDate },
      from: p.sourceBillDate,
    });
  }
  for (const c of checked) {
    const kept = byMonth.get(c.month);
    // A real bill replaces any printed row; between two real bills for the
    // same month, the later one is kept.
    if (kept && kept.entry.source === "checked" && kept.from >= c.billDate) continue;
    byMonth.set(c.month, {
      entry: { month: c.month, source: "checked", amount: c.total, units: c.units, amountPaid: null, printedOn: null },
      from: c.billDate,
    });
  }
  return [...byMonth.values()].map((v) => v.entry).sort((a, b) => a.month.localeCompare(b.month));
}

export function monthName(isoDateOrMonth: string): string {
  const [y, m] = isoDateOrMonth.split("-");
  return `${MONTH_NAMES[Number(m) - 1] ?? "?"} ${y}`;
}

// "as printed on your March bill (not checked by BillShield)"
export function printedLabel(sourceBillDate: string): string {
  const name = MONTH_NAMES[Number(sourceBillDate.slice(5, 7)) - 1] ?? "earlier";
  return `as printed on your ${name} bill (not checked by BillShield)`;
}
