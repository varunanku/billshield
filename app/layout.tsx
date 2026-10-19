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

// Runs before first paint (blocking, as the first thing in <body>) so the
// right theme is already on <html data-theme> before anything renders --
// otherwise there'd be a flash of the wrong theme on every load. Reads a
// saved choice (ThemeSwitcher writes it); first visit falls back to the
// OS's own light/dark preference, per the brief. Wrapped in try/catch --
// localStorage can throw (private browsing, blocked storage), and this
// must never be what breaks the page.
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem("billshield-theme");var valid=["fresh","midnight","mint","sunrise"];if(!t||valid.indexOf(t)===-1){t=window.matchMedia("(prefers-color-scheme: dark)").matches?"midnight":"fresh";}document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable} ${fraunces.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans bg-bg text-text">
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        {children}
      </body>
    </html>
  );
}
