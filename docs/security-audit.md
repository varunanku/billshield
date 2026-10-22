# BillShield security audit (23 Oct 2026)

Audit of the code at commit `fe25c22`, before the security phases. No code was changed for this audit.

## API routes

There are no server actions (`"use server"` appears nowhere). Every mutation goes through the Route Handlers below.

| Route | Checks signed-in user | Input validation | Gaps |
|---|---|---|---|
| `POST /api/bills/extract` | Yes, 401 | Hand-written: `path` must be a string and pass `isValidOwnedPath` (owner's folder, UUID filename, 4 extensions). Server re-checks size (20 MB) and mime type after download. | Uses the service-role client to read storage, so the path check is the only ownership guard (it is correct). No rate limit on our side: each call is a paid vision-model call. |
| `POST /api/bills/confirm` | Yes, 401 | Hand-written: types, enums (role, category), date format, path ownership. | No length limits on provider, labels, promise or units text. No cap on the number of line items. No range on amounts (e.g. `1e300`). Masking runs before storage (good). |
| `POST /api/bills/draft-email` | Yes, 401; RLS check that the bill is the user's | Hand-written: outcome enum, `facts` field types. | `facts` is trusted from the client (by design: not re-derived). No length limits on provider, labels or billDate, which all go into the LLM prompt. `billId` is not UUID-checked (a bad value gives a Postgres error, then 401). No rate limit on Regenerate. |
| `POST /api/bills/[id]/followup` | Yes, 401; RLS check on the bill | Hand-written: question ≤ 1000 chars, enums, number types. | `context` is trusted from the client (same as draft-email). No caps on line-item count or label lengths. The 10-question cap is per bill, so a user can create many bills. `id` is not UUID-checked. |
| `POST /api/bills/[id]/apply-correction` | Yes, 401; RLS check on the bill | Hand-written: field enum, role enum, number types. | No length limit on `new_label`/`reason`. `line_index` is not checked as an integer. `bill_date` correction is not checked for date format. `id` is not UUID-checked. |
| `PATCH /api/messages/[id]` | Yes, 401; RLS on update | Hand-written: `action_taken` enum. | No length limit on `final_body`. `id` is not UUID-checked. |
| `POST /api/messages/[id]/events` | Yes, 401; RLS on insert | Hand-written: `event_type` enum. | No length limit on `final_body`. `id` is not UUID-checked. |
| `GET /auth/callback` | Public by design (it creates the session) | `code` passed to Supabase. | None found. Redirects only to the same origin. |

Pages: `proxy.ts` redirects signed-out visitors to `/login` for every page; API routes return their own 401. `app/bills/page.tsx` reads through the user's RLS-scoped client.

**Sign-up and sign-in** run in the browser, straight against Supabase Auth with the public anon key. The only checks are client-side: a non-empty name and `minLength={6}` on the password. Nothing on our server can rate-limit them unless they go through a server route. Even then, someone holding the anon key can call Supabase Auth directly, so Supabase's own limits and CAPTCHA are the real control (see the dashboard section below).

**Uploads** go straight from the browser to Supabase Storage. Storage RLS limits each user to their own folder (proven by the RLS test). The bucket has no `file_size_limit` and no `allowed_mime_types` set, so the browser-side 10 MB resize logic is the only size control.

## Secrets

- Only `.env.example` is tracked, and it holds no values. No `.env*` file with values appears anywhere in git history.
- A search of the full history (`git log --all -p`) for Groq keys (`gsk_…`), OpenRouter keys (`sk-or-v1-…`) and JWT-shaped Supabase keys found nothing.
- No client component (`"use client"`) reads `process.env` apart from the two `NEXT_PUBLIC_` Supabase values, which are meant to be public. The service-role client is in `lib/supabase/admin.ts`, which imports `server-only`.

## Dependencies (`npm audit`)

- Production dependencies (`--omit=dev`): **0 vulnerabilities.**
- All dependencies: 5 high, all the same advisory (`braces`, GHSA-vfj7-8cjw-p6xm), reached only through `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch`. This is lint tooling and never ships to users. The suggested `npm audit fix --force` downgrades `eslint-config-next`, so I left it alone.

## Security headers (live site, `/login`)

| Header | Present |
|---|---|
| Strict-Transport-Security | Yes (Vercel default) |
| Content-Security-Policy | **No** |
| X-Frame-Options | **No** (the app can be framed: clickjacking risk) |
| Referrer-Policy | **No** |
| Permissions-Policy | **No** |
| X-Content-Type-Options | **No** |

## Prompt injection

Text read off a bill (line labels, provider name) goes into the email and chat prompts as plain text, with no marking that it is data. The verdict and every number are computed in code, so injected text can't change the maths. It could still change the wording of an email or a chat answer. The email's number guard limits the damage to wording only.

## Supabase dashboard settings to change

1. **Auth → Providers → Email:** minimum password length 8 (the app now enforces 8 too). Keep "Confirm email" on.
2. **Auth → Attack Protection:** turn on CAPTCHA (hCaptcha or Cloudflare Turnstile) for sign-up and sign-in. This is the only control a caller using the anon key can't bypass. Also turn on leaked-password protection if your plan includes it.
3. **Auth → Rate Limits:** review the per-hour limits for sign-ups, sign-ins and token refreshes. Set up custom SMTP so email limits aren't the shared default.
4. **Auth → URL Configuration:** Site URL `https://billshield-tau.vercel.app`. Redirect URLs: only that origin's `/auth/callback` (plus `http://localhost:3000/auth/callback` for development). Remove wildcards.
5. **Storage → bills bucket:** set a file size limit (20 MB, the same cap extraction uses) and allowed MIME types `image/jpeg, image/png, image/webp, application/pdf`.
6. **Database → API:** keep "auto-expose new tables" off, as now.
