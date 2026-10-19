import type { Metadata } from "next";
import { Inter, Geist_Mono, Fraunces } from "next/font/google";
import "./globals.css";

// Body + headings -- sharp and modern, not the old warm-paper serif feel.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

// Amounts only -- tabular figures in a true monospace read as more
// precise/trustworthy for money than proportional tabular-nums.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// The BillShield wordmark only -- every other heading uses Inter now.
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  axes: ["opsz"],
});

export const metadata: Metadata = {
  title: "BillShield — Check your bill before you pay",
  description: "Check your bill before you pay it.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable} ${fraunces.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans bg-paper text-ink">{children}</body>
    </html>
  );
}
