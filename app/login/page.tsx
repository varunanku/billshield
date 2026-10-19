"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

// Minimal email/password auth -- nothing in CLAUDE.md's build order asked
// for this page, but the upload flow needs a signed-in user for RLS to
// mean anything, and nothing existed yet. Swap for magic-link/OAuth later
// if you'd rather.
export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSignIn() {
    setLoading(true);
    setMessage(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    router.push("/");
    router.refresh();
  }

  async function handleSignUp() {
    setLoading(true);
    setMessage(null);
    const { error } = await supabase.auth.signUp({ email, password });
    setLoading(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    setMessage("Account created. Check your email to confirm, then sign in.");
  }

  const inputClasses =
    "w-full min-h-11 rounded-lg border border-line bg-card px-3 py-2 text-ink placeholder:text-ink-muted outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:border-primary";

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-paper px-4 py-12">
      <div className="w-full max-w-sm animate-fade-up">
        <div className="overflow-hidden rounded-lg border border-line bg-card shadow-card">
          <div className="h-1 w-full bg-linear-to-r from-primary to-emerald" aria-hidden />

          <div className="flex flex-col gap-6 p-6">
            <div className="flex flex-col items-center gap-2 text-center">
              <svg viewBox="0 0 32 32" fill="none" className="h-12 w-12" aria-hidden>
                <path d="M16 2.5 L28 7 V15.5 C28 23 22.5 27.5 16 29.5 C9.5 27.5 4 23 4 15.5 V7 Z" className="fill-primary" />
                <path
                  d="M11 16.2 L14.3 19.5 L21.2 11.8"
                  stroke="#ffffff"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
              <h1 className="font-serif text-3xl font-semibold">BillShield</h1>
              <p className="text-ink-muted">Check your bill before you pay it.</p>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSignIn();
              }}
              className="flex flex-col gap-3"
            >
              <label className="flex flex-col gap-1 text-sm">
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className={inputClasses}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  className={inputClasses}
                />
              </label>
              <button
                type="submit"
                disabled={loading}
                className="min-h-11 rounded-lg bg-primary px-4 py-2 font-medium text-white transition-all duration-150 hover:bg-primary-hover active:scale-[0.97] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={handleSignUp}
                disabled={loading}
                className="min-h-11 rounded-lg border border-line px-4 py-2 font-medium text-ink transition-all duration-150 hover:bg-primary-soft hover:border-primary active:scale-[0.97] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                Create account
              </button>
            </form>
            {message && (
              <p role="status" className="text-center text-sm text-ink-muted">
                {message}
              </p>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
