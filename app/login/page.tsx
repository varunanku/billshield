"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { signUpMetadata } from "@/lib/auth";

// Minimal email/password auth -- nothing in CLAUDE.md's build order asked
// for this page, but the upload flow needs a signed-in user for RLS to
// mean anything, and nothing existed yet. Swap for magic-link/OAuth later
// if you'd rather.
export default function LoginPage() {
  const router = useRouter();
  const supabase = createClient();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function switchMode(next: "signin" | "signup") {
    setMode(next);
    setMessage(null);
  }

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
    if (!fullName.trim()) {
      setMessage("Please enter your full name.");
      return;
    }
    setLoading(true);
    setMessage(null);
    const { error } = await supabase.auth.signUp({
      email,
      password,
      // window.location.origin, not a hardcoded URL -- works the same on
      // localhost, a Vercel preview deploy, and production.
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        data: signUpMetadata(fullName),
      },
    });
    setLoading(false);
    if (error) {
      setMessage(
        /rate limit/i.test(error.message)
          ? "Too many sign-ups right now. Please wait a few minutes and try again."
          : error.message
      );
      return;
    }
    setMessage("Account created. Check your email to confirm, then sign in.");
  }

  function handleSubmit() {
    if (mode === "signin") {
      handleSignIn();
    } else {
      handleSignUp();
    }
  }

  const inputClasses =
    "w-full min-h-11 rounded-lg border border-border bg-surface px-3 py-2 text-text placeholder:text-text-muted outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-accent";

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-sm animate-fade-up">
        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-card">
          <div className="h-1 w-full bg-linear-to-r from-accent to-success" aria-hidden />

          <div className="flex flex-col gap-6 p-6">
            <div className="flex flex-col items-center gap-2 text-center">
              <svg viewBox="0 0 32 32" fill="none" className="h-12 w-12" aria-hidden>
                <path d="M16 2.5 L28 7 V15.5 C28 23 22.5 27.5 16 29.5 C9.5 27.5 4 23 4 15.5 V7 Z" className="fill-accent" />
                <path
                  d="M11 16.2 L14.3 19.5 L21.2 11.8"
                  stroke="var(--accent-contrast)"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </svg>
              <h1 className="font-serif text-3xl font-semibold">BillShield</h1>
              <p className="text-text-muted">Check your bill before you pay it.</p>
            </div>

            <p className="text-center text-sm text-text-muted">
              BillShield checks the maths and tax on your bill against official rates, flags anything wrong, and
              drafts a ready-to-send message -- or confirms it&apos;s clean.
            </p>

            <div role="tablist" className="flex gap-1 rounded-lg border border-border bg-surface-alt p-1">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "signup"}
                onClick={() => switchMode("signup")}
                className={`min-h-11 flex-1 rounded-md text-sm font-medium transition-colors ${
                  mode === "signup" ? "bg-accent text-accent-contrast" : "text-text-muted hover:text-text"
                }`}
              >
                New here? Sign up
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "signin"}
                onClick={() => switchMode("signin")}
                className={`min-h-11 flex-1 rounded-md text-sm font-medium transition-colors ${
                  mode === "signin" ? "bg-accent text-accent-contrast" : "text-text-muted hover:text-text"
                }`}
              >
                Already have an account? Sign in
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSubmit();
              }}
              className="flex flex-col gap-3"
            >
              {mode === "signup" && (
                <label className="flex flex-col gap-1 text-sm">
                  Full name
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    required
                    className={inputClasses}
                  />
                </label>
              )}
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
                className="min-h-11 rounded-lg bg-accent px-4 py-2 font-medium text-accent-contrast transition-all duration-150 hover:bg-accent-hover active:scale-[0.97] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
              >
                {mode === "signin" ? "Sign in" : "Create account"}
              </button>
            </form>
            {message && (
              <p role="status" className="text-center text-sm text-text-muted">
                {message}
              </p>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
