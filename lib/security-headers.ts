// Response headers for every route (next.config.ts). The browser only ever
// talks to this app and to Supabase (auth, storage uploads); fonts are
// self-hosted by next/font and every LLM call is server-side.
//
// ponytail: script-src allows 'unsafe-inline' because Next.js inlines its
// own bootstrap scripts and layout.tsx has a pre-paint theme script.
// Upgrade path: per-request nonces from proxy.ts, which would make every
// page dynamic (it currently uses cacheComponents/partial prerendering).
export function securityHeaders(supabaseUrl: string | undefined, isDev: boolean): { key: string; value: string }[] {
  const supabase = supabaseUrl ? new URL(supabaseUrl) : null;
  const connect = ["'self'"];
  if (supabase) connect.push(supabase.origin, `wss://${supabase.host}`);
  if (isDev) connect.push("ws:", "http://localhost:*");

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  return [
    { key: "Content-Security-Policy", value: csp },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
    },
    { key: "X-Content-Type-Options", value: "nosniff" },
  ];
}
