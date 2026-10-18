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

  return (
    <main style={{ maxWidth: 360, margin: "4rem auto", padding: "0 1rem" }}>
      <h1>BillShield</h1>
      <p>Sign in or create an account.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSignIn();
        }}
        style={{ display: "flex", flexDirection: "column", gap: 8 }}
      >
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={6}
        />
        <button type="submit" disabled={loading}>
          Sign in
        </button>
        <button type="button" onClick={handleSignUp} disabled={loading}>
          Create account
        </button>
      </form>
      {message && <p role="status">{message}</p>}
    </main>
  );
}
