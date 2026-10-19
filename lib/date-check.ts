// Pure, no network -- flags a bill date that's implausible: in the future,
// or more than 18 months before the upload. Both are the same real-world
// failure mode: a 2-digit year misread (e.g. "24" read as 1924 rather
// than 2024), which the extraction prompt is told to avoid, but code
// checks for too (hard rule 2: never just trust the prompt).
const SUSPICIOUS_MONTHS = 18;

function monthsBetween(earlier: Date, later: Date): number {
  return (later.getFullYear() - earlier.getFullYear()) * 12 + (later.getMonth() - earlier.getMonth());
}

export function isSuspiciousBillDate(billDate: string, now: Date = new Date()): boolean {
  const parsed = new Date(billDate);
  if (Number.isNaN(parsed.getTime())) return false; // not a parseable date -- nothing to flag
  if (parsed.getTime() > now.getTime()) return true;
  return monthsBetween(parsed, now) > SUSPICIOUS_MONTHS;
}
