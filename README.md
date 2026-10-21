# BillShield

**Upload a bill. Get the maths checked. Send one message if something's wrong.**

BillShield reads a bill you don't fully trust, checks every number in code (never with AI), and gives you an honest verdict. If the bill is correct, it shows you the arithmetic. If it isn't, you get a ready-to-send dispute email that points at the exact line that doesn't add up.

- **Live app:** https://billshield-tau.vercel.app
- **Repo:** https://github.com/varunanku/billshield

Built solo by [Varun Sharma](https://github.com/varunanku) for the 100x Engineers Cohort 8, Module 2 hackathon (code track, 72 hours).

---

## What it does

1. **Upload** a bill (PNG, JPEG, WEBP, PDF or a screenshot). You can also say what you were promised.
2. **AI reads** the text on the bill and turns it into line items. Personal details are masked by a pattern-based backstop before anything is stored or sent to the model.
3. **You review** the extracted lines, fix any misreads, and confirm.
4. **Code checks** every number: line totals, subtotals, tax rates against CBIC-sourced GST rates, the grand total, and the gap between amount billed and amount paid.
5. **Verdict.** There are four possible outcomes:
   - **Clean:** every line checks out, and the maths is shown. This counts as a real result.
   - **Confirmed error:** a specific line doesn't add up. A dispute email is drafted.
   - **Cannot verify:** the bill couldn't be read fully. The app says so plainly.
   - **Unexplained line:** a charge the app can't account for. The email asks the provider to explain it.

   If the bill's printed total differs from the amount you said you expected, that is never called an error. The headline reads "This bill is Rs X higher than the amount you expected", it names any single line within Rs 2 of the gap (for example a late payment surcharge), and the email asks the provider to explain the difference.
6. **Dispute email** written only from numbers the code has verified. It has 6 tone presets, can be regenerated, and offers Copy, Open in email app, and "I've sent it" tracking. If the user overpaid, it drafts a refund request instead.
7. **Follow-up chat** answers questions from the bill's computed facts. It can explain a line, check a tax rate, or compare with earlier bills from the same provider.

## Key design rules

- **API keys never reach the browser.** The LLM key and Supabase service-role key are used only in server routes. No secret ever gets a `NEXT_PUBLIC_` prefix.
- **Every number comes from code, never from AI.** The LLM reads text off the bill, sorts it into a fixed list of categories, and writes the wording. Code does every total, tax, difference, month-over-month change and verdict. A guard rejects any drafted email that contains a number the code didn't supply.
- **Row-level security on every table.** A user can only read and write their own rows. This is proven by a 48-check two-user test covering all 8 tables, storage, and blocked writes.
- **Honest boundaries.** The app can't confirm legal or policy correctness, so it says so instead of guessing. GST findings are stated with confidence because they come from a hard-coded table. Notes about handling charges and similar fees are informational only.

## Features

- **Direct-to-storage upload.** Bills go straight from the browser to Supabase Storage. This gets around Vercel's 4.5 MB request size limit for serverless functions. Storage paths are checked with an anchored regex so users can only touch their own folder.
- **GST verification.** Tax rates are checked against 39 rates sourced from CBIC (Notification 09/2025). They cover groceries, appliances, electronics, cosmetics, internet, software, electricity and mobile. A rate is checked only when an HSN/SAC code is printed on the bill, and only overcharges are flagged. If no rate is confirmed, the app checks the arithmetic only and says so.
- **Bill history.** Each bill is tagged with a category and billing period, and bills from the same provider are compared month over month.
- **4 themes.** Fresh, Midnight, Mint and Sunrise. Each theme defines 10 paired CSS colour tokens. The app follows your OS light/dark setting and remembers your choice.
- **Name capture at sign-up.** Your name appears in the header, and code adds it to the email signature.
- **AI labelling.** Everything the AI writes carries a badge and a disclaimer. The UI keeps "BillShield's checks" (code) separate from "the AI" (wording).
- **Editable review screen.** Fields are read-only until you tap the pencil to edit one. Checkpoint suggestions (for example, "remove this line") fix common misreads in one click.
- **Follow-up chat with suggestion chips.** Code picks the chips from what the bill actually contains. Each bill allows up to 10 questions.
- **6 tone presets** for the email: Polite, Firm, Formal, Brief, Friendly and Escalation. Which preset you use is tracked so tone usage can be reported.
- **Reliable photo uploads.** Photos over 1.5 MB or 2000 px are resized in the browser to a 2000 px JPEG before upload (PDFs are left alone). A dropped connection is retried once, then the app suggests a screenshot instead.
- **Android Google Photos uploads fixed.** Photos are read into memory the moment they're picked. Uploads from Android's Google Photos picker used to fail silently with "Failed to fetch", and the Supabase logs confirmed nothing reached the server.
- **Send funnel.** Copy, Open in email app and "I've sent it" are each logged, along with how much of the first draft the user kept (word-level similarity, computed in code). `scripts/tone-stats.mjs` reports the funnel.

## Tech stack

| Layer | Choice |
|-------|--------|
| Framework | Next.js 16 (App Router) + TypeScript, React 19, Tailwind CSS 4 |
| Database / Auth / Files | Supabase (Postgres with RLS, Auth, Storage) |
| Extraction and wording | Groq (`qwen/qwen3.8-27b` vision model), called only from server routes. An OpenRouter path is kept as an alternative. |
| PDF handling | `mupdf` turns PDF pages into images on the server |
| Hosting | Vercel, deploying automatically from `main` |

## Database schema

There are 8 Postgres tables, all with RLS. Full column details are in [`docs/schema.md`](docs/schema.md).

| Table | Purpose |
|-------|---------|
| `users` | One row per account, including `full_name` |
| `bills` | One row per upload: provider, date, total, category, billing period, verdict |
| `line_items` | Individual lines on the bill, each with a role (charge/tax/discount/payment/balance/subtotal/info). Includes "Amount Paid" for billed-vs-paid differences. |
| `promises` | What the user was told or expected to pay |
| `messages` | Drafted emails and chat turns: `tone_preset_used`, `final_body`, `action_taken`, `draft_kept_pct`, and a link to the disputed `line_items` row (the proof link) |
| `category_rates` | GST reference rates from CBIC (39 rows): `rate_percent`, `rate_type`, `source_note`, `last_verified` |
| `bill_metrics` | Units consumed and meter readings, used for month-over-month comparison |
| `message_events` | One row per Copy / Open in email app / I've sent it tap, with `draft_kept_pct` at that moment. Append-only (no update or delete). |

The difference is always computed in code as `amount_billed - amount_paid`. A positive value means a dispute to the provider. A negative value means the user overpaid, so the app drafts a refund request.

## Local development

```bash
# 1. Clone
git clone https://github.com/varunanku/billshield.git
cd billshield

# 2. Install
npm install

# 3. Environment: copy .env.example to .env.local and fill in
#    NEXT_PUBLIC_SUPABASE_URL=       safe for the browser
#    NEXT_PUBLIC_SUPABASE_ANON_KEY=  safe for the browser
#    SUPABASE_SERVICE_ROLE_KEY=      server only
#    GROQ_API_KEY=                   server only
#    EXTRACTION_PROVIDER=groq        (if unset, the OpenRouter path is used)
#    OPENROUTER_API_KEY=             optional, only for the OpenRouter path
#    OPENROUTER_MODEL=               optional
cp .env.example .env.local

# 4. Run migrations 0001 through 0011 in order in the Supabase SQL editor.
#    They live in supabase/migrations/ and are safe to run more than once.
#    Then seed the GST table:
node --env-file=.env.local scripts/seed-category-rates.mjs

# 5. Start
npm run dev
```

Never commit `.env.local`. In production, the same variables are set in Vercel's Environment Variables.

## Testing

```bash
# Unit tests: maths, verdict, GST, storage paths, chat chips, email guard, history...
npm test

# RLS proof: creates two users and checks that neither can read or write
# the other's rows or files (needs the service-role key in .env.local)
node --env-file=.env.local scripts/rls-two-user-test.mjs
# Expected: 48/48 checks passed
```

The golden pairs used for regression testing are an Airtel Wi-Fi bill and a Tata Power electricity bill.

## Project structure

```
├── app/
│   ├── page.tsx                  # Upload → review → verdict → email → chat
│   ├── bills/page.tsx            # Bill history
│   ├── login/page.tsx            # Sign up (with name) / sign in
│   ├── auth/callback/route.ts    # Email-confirmation callback
│   ├── theme-switcher.tsx        # 4-theme dropdown
│   └── api/
│       ├── bills/extract/        # Masking backstop + AI extraction
│       ├── bills/confirm/        # Save reviewed lines, run checks, return verdict
│       ├── bills/draft-email/    # Email wording with tone presets
│       ├── bills/[id]/followup/  # Follow-up chat grounded in the facts
│       ├── bills/[id]/apply-correction/
│       └── messages/[id]/        # Record "sent" / "not sending"; events/ logs funnel taps
├── lib/
│   ├── bill-checks.ts            # Arithmetic checks, checkpoints, line roles
│   ├── verdict.ts                # The four-outcome verdict
│   ├── gst.ts                    # Tax breakdown and rate comparison
│   ├── mask.ts                   # PII masking backstop
│   ├── email-draft.ts            # Prompt, number guard, template fallback
│   ├── followup.ts               # Chat facts and grounding
│   ├── chat-chips.ts             # Suggestion chips picked in code
│   ├── history.ts                # Month-over-month comparison
│   ├── date-check.ts             # Due dates / late fees as printed
│   ├── groq.ts, openrouter.ts, provider.ts   # LLM providers (server only)
│   ├── pdf-to-images.ts          # mupdf PDF rendering
│   ├── storage-paths.ts          # Anchored path validation
│   ├── upload-image.ts           # In-browser photo resize + network-error check
│   ├── draft-kept.ts             # How much of the first draft was kept
│   ├── tone-stats.ts             # Tone usage and send-funnel aggregation
│   ├── supabase/                 # Browser, server and admin clients
│   └── *.test.mjs                # Unit tests
├── data/category-rates.csv       # 39 CBIC-sourced GST rates
├── scripts/
│   ├── rls-two-user-test.mjs     # 48-check RLS proof
│   ├── seed-category-rates.mjs   # Load the GST table
│   ├── extract-regression.mjs    # Extraction regression on sample bills
│   └── tone-stats.mjs            # Tone usage and send-funnel report
├── supabase/migrations/          # 0001–0011
├── docs/schema.md
└── CLAUDE.md                     # Build rules for AI-assisted development
```

## Extraction provider history

1. **Groq** (free tier, vision model) was the starting point: fast and free.
2. **Gemini** came next for accuracy. It read complex electricity bills almost perfectly, including Hindi labels. In production it started returning 500 errors.
3. **OpenRouter** was tried as a single API in front of Gemini and other models. It also failed in production.
4. **Back to Groq**, which was the provider that stayed up. Reliability mattered more than a small gain in accuracy, because the review screen lets users fix misreads anyway.

The extraction layer doesn't depend on one provider. You switch with the `EXTRACTION_PROVIDER` environment variable, and no code changes are needed.

## Bugs found by real users and fixed

| # | Bug | Found by | Root cause | Fix |
|---|-----|----------|------------|-----|
| 1 | Sign-up confirmation email linked to `localhost:3000` | Classmate | Supabase Site URL still pointed at localhost | Set the Site URL in the dashboard, and the code now sends `emailRedirectTo` from `window.location.origin` |
| 2 | Sign-up failed with a raw "email rate limit exceeded" error | Classmates testing at the same time | Supabase's built-in mailer allows only a few sign-up emails per hour | Detect the rate-limit error and show a plain "wait a few minutes" message |
| 3 | White text on a white background in dark mode | Classmate | Colours were hard-coded instead of using theme tokens | Built the 4-theme token system |
| 4 | "Total Tax" counted twice alongside CGST + SGST | Classmate (Urban Company bill) | The summary tax line was treated as a separate charge | Detect summary lines that equal the sum of their component taxes |
| 5 | A missing provider blocked the Confirm button | Classmate (HP gas bill) | A null provider was treated as invalid | Allow a null provider and mark the field "(optional)" |
| 6 | False "underpaid by ₹971" on a Pay-On-Delivery bill | Classmate (HP gas bill) | A zero payment was read as an underpayment | Ignore zero-amount payment lines |
| 7 | False "expected 18%" on a 5% LPG bill | Smoke test | The category was guessed without a printed HSN code | Require a printed HSN/SAC match, and flag only overcharges |
| 8 | Chat contradicted the verdict on an Airtel bill | Smoke test | The verdict's matched line and sign weren't passed to the chat | Chat facts now include the matched line, the sign and the tax total from the verdict |

## Limitations

- GST only (India). Foreign VAT is out of scope.
- One dispute email per bill, pointing at one line.
- No forgery detection, no web lookup for support emails, and no multi-document cases.
- The app checks maths, not whether a charge is legally or contractually allowed.

## License

Built for a hackathon. Not licensed for production use.
