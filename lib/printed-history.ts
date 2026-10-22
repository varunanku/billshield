// Past months as printed on an electricity or water bill (amounts, units,
// payments). Pure, no network. These rows are context only: they never
// enter line items, the arithmetic checks or the verdict. Merging them with
// saved bills month by month happens in the database view
// provider_monthly_timeline (migration 0015; display in lib/timeline.ts).

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
