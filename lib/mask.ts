// Pattern-based masking backstop (CLAUDE.md hard rule 3). Runs on the LLM's
// extracted TEXT fields (provider name, line item labels) before anything
// is stored -- not on amounts/dates/totals, which must stay exact for the
// maths check. The user is asked to mask their own details before upload;
// this is the code-side backstop for when they don't.
//
// ponytail: regex-only, no NER/address-parsing model. Catches the common
// shapes (email, Indian mobile, long account/card-like digit runs, PIN
// codes), not every possible address format. Upgrade path: a proper PII
// detection pass if live testing turns up real misses, same way the
// masking gap was found in testing (Kushagra's unmasked Amazon invoice).

const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Indian mobile numbers: optional +91/0 prefix, then a 10-digit number
// starting 6-9.
const INDIAN_MOBILE = /(?:\+91[-\s]?|0)?[6-9]\d{9}\b/g;

// Account/card/consumer numbers: any run of 9+ digits, allowing embedded
// spaces or hyphens (how card/account numbers are usually printed).
// Deliberately broader than the mobile pattern above; also mask 6-digit
// standalone numbers, which on an Indian address line are almost always a
// PIN code.
const LONG_DIGIT_RUN = /\b\d(?:[\d\s-]{7,}\d)\b/g;
const PIN_CODE = /\b\d{6}\b/g;

export function maskPII(text: string): string {
  if (!text) return text;
  return text
    .replace(EMAIL, "[masked-email]")
    .replace(INDIAN_MOBILE, "[masked-phone]")
    .replace(LONG_DIGIT_RUN, "[masked-number]")
    .replace(PIN_CODE, "[masked-number]");
}
