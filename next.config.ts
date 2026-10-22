import type { NextConfig } from "next";
import { securityHeaders } from "./lib/security-headers";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NODE_ENV !== "production"),
      },
    ];
  },
  cacheComponents: true,
  partialPrefetching: true,
  // mupdf ships a WASM binary; keep it a real dependency instead of letting
  // the bundler try to transform it.
  serverExternalPackages: ["mupdf"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
