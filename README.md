# BillShield

Upload a bill and, optionally, what you were promised. BillShield checks the
maths in code and either confirms the bill is correct or drafts one dispute
email pointing at the wrong or unexplained line.

Built for the 100x Engineers Cohort 8 Module 2 hackathon. See `CLAUDE.md` for
scope, data model and hard rules.

## Stack

Next.js (App Router) + TypeScript, Supabase (auth, Postgres with RLS, storage),
LLM called only from server routes. Deployed on Vercel.

## Local setup

```bash
npm install
cp .env.example .env   # fill in; .env is gitignored
npm run dev
```

Secrets live in `.env` locally and Vercel Environment Variables in production.
Never give a secret a `NEXT_PUBLIC_` prefix.
