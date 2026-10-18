# 4. Database schema

**Questions the app must answer next month:** the brief's Move 4 prompt, what should this schema be able to answer later, not just today. A few worth naming: how many bills came back clean versus flagged; which categories and providers get flagged most often; and, of the flagged ones, how many actually got sent (answered already by `messages.action_taken`, no new storage needed).

One more, raised from the Airtel pair directly: for a recurring bill from the same provider, is this month's amount consistent with recent months, or is there an unexplained jump, the way the June ₹470.82 bill was a silent ₹118 deviation from an otherwise steady ~₹352.82, with correct arithmetic that month and so invisible to a single-bill check. The schema already supports this without new tables: `bills` already carries `user_id`, `provider_name`, `bill_date` and `total_amount`, so a query across a user's own bills for the same provider, ordered by date, computes the month-over-month delta directly. If a user uploads two or three months of a recurring bill, the verdict can note the delta against recent history, and flag an unexplained jump the same way a bad line item is flagged. This is a natural extension, worth naming here, but not required for the 72-hour build unless time allows; it needs no new table, so it's safe to leave for later without reworking the schema.

Six tables in Postgres (for example Supabase), linked by foreign keys. Rows hold facts; files hold bytes. Types below are a starting point, to be confirmed when the tables are built.

**How they connect:** a user has many bills; a bill has many line items; a bill can have an optional promise; a message points at the one line item it disputes. That last link is the proof chain.

## users

One row per account. Login is handled by the auth layer, and every row-level security policy keys off the signed-in user's id.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid, primary key | Same id as the auth account |
| email | text | For login only |
| created_at | timestamptz | |

## bills

One row per uploaded document. It holds the header facts only; individual charges live in `line_items`.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid, primary key | |
| user_id | uuid, foreign key to users | Owner; used by row-level security |
| provider_name | text | Company on the bill, for example Airtel |
| bill_date | date | |
| total_amount | numeric(12,2) | The total as printed on the bill |
| file_path | text | Link to the stored image or PDF, not the file itself |
| support_contact | text, nullable | Only if the bill prints one; never guessed |
| category | text, nullable | LLM-assigned, one of a closed list: broadband, electricity, mobile_recharge, food, electronics, other |
| created_at | timestamptz | |

**Why the image is stored:** the stored file is the evidence behind every verdict. It lets the user show the original bill again if a provider asks, lets them re-check the result later, and lets a reviewer see the exact bill that produced the output. The row keeps only the link.

## line_items

One row per charge on a bill: the label and the amount.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid, primary key | |
| bill_id | uuid, foreign key to bills | |
| line_order | integer | Position on the bill |
| label | text | For example Static IP Charges, GST, Fixed charge |
| amount | numeric(12,2) | |
| flagged | boolean | True if code flagged this line |

**Why rows, not columns:** a restaurant bill, an electricity bill and a phone recharge have different charge names. With one column per charge type, the table would need a new column for every new bill type. With one row per charge, every bill type fits the same two fields, label and amount, and no schema change is needed.

## promises

Optional. What the user says they were told or expected, for example "I asked a technician at installation to remove this."

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid, primary key | |
| bill_id | uuid, foreign key to bills | |
| statement | text | The user's own words |
| source | text, nullable | Optional: verbal, written or plan page |
| created_at | timestamptz | |

**A promise is user-asserted and unverifiable.** It is not proof and is never treated as ground truth. It does two things only: it triggers a comparison between the bill and the stated expectation, and it shifts the email to an inquiry tone (section 5).

**Schema addition from live testing (Hemant's Airtel receipt):** a bill can carry an actual-amount-paid figure that differs from the billed/promised amount in either direction, not just a provider overcharge. Rather than adding a new table, `line_items` gains the case where a line's `label` is the paid amount itself (for example "Amount Paid") and code computes `amount_billed − amount_paid` as a signed difference: positive means the provider is owed more or the user underpaid, negative means the user overpaid and is owed a refund or credit. The tone and drafted message differ by sign: a negative difference drafts a refund-request email to the provider; a positive one is the existing arithmetic-dispute path. This needs no new column type, just an explicit signed calculation in code rather than an unsigned "flagged: true/false", and the draft-email wording branches on the sign.

## messages

The AI-drafted email or verdict, saved with a link to the line it disputes.

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid, primary key | |
| bill_id | uuid, foreign key to bills | |
| line_item_id | uuid, foreign key to line_items, nullable | The disputed line; empty for a clean verdict |
| promise_id | uuid, foreign key to promises, nullable | Set when the email rests on a promise |
| subject | text | |
| body | text | The drafted version, as first generated |
| tone | text | confident or inquiry |
| created_at | timestamptz | The timestamp of the draft |
| action_taken | text, nullable | sent_as_is, sent_with_tone_preset, sent_manually_edited, or not_sent |
| tone_preset_used | text, nullable | For example more_formal, more_concise, friendlier; set only if a preset was used |
| final_body | text, nullable | What was actually sent, captured from the in-app editor, if it differs from body |

**The proof chain:** message to line_item is the one link the submission rests on. It shows that a specific email was drafted about a specific charge. What it was drafted into and what actually went out is captured as an observed UI action, not a self-report: the editable message sits in an in-app text box with three one-click tone presets alongside it, for example more formal, more concise, friendlier. The app logs which path the user took, sent the draft as-is, applied a preset then sent, or edited it manually, rather than asking the user to report how many words they changed. This is both more reliable, since it needs no honesty or bookkeeping from the user, and cheap to compute, since it is a UI event, not a word-level diff against pasted-back text.

## category_rates

A small, hand-maintained reference table, not user data; seeded once with only the categories a confident rate could be sourced for.

| Column | Type | Notes |
| --- | --- | --- |
| category | text, primary key | Matches bills.category |
| rate_percent | numeric(5,2), nullable | For example 18.00; null if not sourced |
| rate_type | text | gst_flat, slab_based, or not_confirmed |
| source_note | text, nullable | Where the rate came from, for Varun's own reference |
| last_verified | date, nullable | |

If a bill's category has no row here, or rate_percent is null, the verdict falls back to arithmetic-only, maths is checked, no claim is made about whether the rate itself is correct.

## Row-level security and privacy

- **RLS:** every table is restricted so a user can only read and write their own rows. For line_items, promises and messages, ownership follows the bill's user_id. This must pass the brief's two-user test: user A cannot see user B's data.
- **Store the least:** account numbers, phone numbers and addresses are masked before anything is saved.
