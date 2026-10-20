# BillShield

Solo build for the 100x Engineers Cohort 8, Module 2 hackathon (code track). 72 hours, started Sat 17 Oct 2026 9 PM IST. Final submission Tue 20 Oct 2026 9 PM IST.

## What it does

A user uploads a bill and, optionally, what they were promised. BillShield checks the maths in code and returns one of two outcomes:

1. **Clean bill:** confirms the bill is correct. This is an equally valid result.
2. **Flagged bill:** drafts one dispute email pointing at the wrong or unexplained line.

Win condition: the user actually sends the message (or consciously chooses not to).

## Hard rules (never break these)

1. **API keys never reach the browser.** The LLM key and Supabase service key are used only in server-side code. Never use a `NEXT_PUBLIC_` prefix for secrets. Never commit `.env`.
2. **Every number comes from code, never from the LLM.** Totals, taxes, differences, recurring-charge deltas, dates and late fees are computed or read in code. The LLM only does OCR cleanup, classification into a closed category list, and wording of the email or explanation. Dates and late fees are populated only from what is printed on the bill.
3. **Mask personal data twice.** The user masks their own details first. After OCR, code runs a pattern-based backstop (phone, email, account/card/consumer numbers, addresses) before anything is stored or sent to the LLM. Live testing showed users do not always mask, so the backstop is mandatory.
4. **Row-level security on every table.** A user can only read and write their own rows. This must be proven with a two-user test.
5. **Honest boundaries.** The app cannot confirm legal or policy correctness. It says so rather than guessing.

## Stack (confirm before scaffolding)

- Next.js (App Router) + TypeScript, deployed on Vercel from GitHub `main`
- Supabase: auth, Postgres with RLS, file storage
- LLM API called only from server routes
- Secrets in local `.env` and Vercel Environment Variables only

## Data model (six tables)

Full column detail is in the BillShield submission document. Table names:

- `users`
- `bills` (includes `category`)
- `line_items` (can hold an "Amount Paid" label for signed paid-vs-billed differences)
- `promises`
- `messages` (includes `action_taken`, `tone_preset_used`, `final_body`; links back to the `line_items` row it disputes: the proof link)
- `category_rates` (`category`, `rate_percent`, `rate_type`, `source_note`, `last_verified`)

Signed difference: code computes `amount_billed - amount_paid`. Positive means a dispute email to the provider. Negative means the user overpaid, so draft a refund request.

## Scope decisions

- `category_rates` is **India GST only**. Foreign VAT is out of scope. When no rate is confirmed, fall back to arithmetic-only checks and say so.
- GST answers are confident (hard-coded table). Handling-charge and similar answers are informational and non-committal.
- Recurring bills are tracked month over month using existing tables, with no new table.
- If something is unexplained, the email asks the **provider** to clarify, not the user.
- One dispute email per bill, pointing at one line.
- Follow-up questions are capped at 10 per bill, answered from the bill and the rates table.

## UI

Form-first core flow: upload, optional promise, result. A small chat-style box under the result handles follow-up questions and soft-failure explanations only. Keep screens minimal and plain-language.

## Out of scope

Forgery detection, web lookup of unlisted support emails, multi-document cases, promise versioning, resolution tracking.

## Build order

1. Supabase tables, auth and RLS (prove with two users)
2. Upload, masking backstop, OCR to line items
3. Code-side maths and verdict logic
4. LLM classification and email wording
5. UI around the working backend
6. Deploy to Vercel and check the live link

## Working style

- Build one layer at a time and commit after each working layer with a clear message.
- Do not add features outside this file without asking.
- Test with the golden pairs (Airtel Wi-Fi, Tata Power electricity) before moving on.
- Use real, unaltered bills for evidence and mask PII before posting anywhere.
- Prefer simple and working over clever. Time is short.

## Deadlines (IST)

- Mon 19 Oct 9 PM: data tables locked
- Tue 20 Oct 9 AM: classmate test
- Tue 20 Oct 9 PM: stranger test (unassisted), then final submission with live link and public repo
