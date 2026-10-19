"use client";

import { useState } from "react";

const THEMES = [
  { value: "fresh", label: "Fresh" },
  { value: "midnight", label: "Midnight" },
  { value: "mint", label: "Mint" },
  { value: "sunrise", label: "Sunrise" },
] as const;
type Theme = (typeof THEMES)[number]["value"];
const STORAGE_KEY = "billshield-theme";

// A small palette-icon dropdown in the header. The actual theme is a plain
// data-theme attribute on <html>, set synchronously before paint by the
// bootstrap script in layout.tsx -- this component only reflects/changes
// that, it doesn't own where the theme is applied from.
export function ThemeSwitcher() {
  // Lazy initializer, not a useState+useEffect pair -- the bootstrap script
  // in layout.tsx already set data-theme before this component ever mounts,
  // and theme only affects markup inside the closed-by-default dropdown, so
  // there's no hydration mismatch to worry about reading it straight off.
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof document === "undefined") return "fresh";
    const current = document.documentElement.getAttribute("data-theme") as Theme | null;
    return current ?? "fresh";
  });
  const [open, setOpen] = useState(false);

  function choose(next: Theme) {
    setTheme(next);
    setOpen(false);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Best-effort -- the theme still applies for this session even if it
      // can't be remembered (private browsing, blocked storage).
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Change theme"
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-9 w-9 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-accent-soft hover:text-accent"
      >
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden>
          <path
            d="M12 2.5a9.5 9.5 0 1 0 9.5 9.5 1.8 1.8 0 0 0-1.8-1.8h-2a2.2 2.2 0 0 1-1.6-3.7A1.6 1.6 0 0 0 15 3.9 9.5 9.5 0 0 0 12 2.5Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <circle cx="7.3" cy="10.3" r="1.1" fill="currentColor" />
          <circle cx="10.7" cy="6.6" r="1.1" fill="currentColor" />
          <circle cx="15.3" cy="7.8" r="1.1" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-10 mt-2 w-36 rounded-lg border border-border bg-surface p-1 shadow-card">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="menuitemradio"
              aria-checked={theme === t.value}
              onClick={() => choose(t.value)}
              className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent-soft ${
                theme === t.value ? "font-bold text-accent" : "text-text"
              }`}
            >
              {t.label}
              {theme === t.value && <span aria-hidden>✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
