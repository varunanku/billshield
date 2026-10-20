// Pure, no network -- the friendly confirmation shown after Copy/Open in
// email app/"I've sent it". Never claims BillShield itself sent anything;
// it only thanks the user for using the tool and wishes them luck.
export const UNKNOWN_PROVIDER = "your provider"; // same sentinel app/api/bills/confirm/route.ts falls back to

export function buildThankYouMessage(fullName: string | null, provider: string | null): string {
  const firstName = fullName?.trim().split(/\s+/)[0] || null;
  const knownProvider = provider && provider !== UNKNOWN_PROVIDER ? provider : null;

  const greeting = firstName ? `Thanks for trusting BillShield, ${firstName}.` : "Thanks for trusting BillShield.";
  const withProvider = knownProvider ? ` with ${knownProvider}` : "";
  return `${greeting} BillShield hopes this message helps you get this sorted${withProvider}. Good luck!`;
}
