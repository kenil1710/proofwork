"use client";

import { useTheme } from "@/components/ThemeProvider";

/**
 * Sun/moon switch for the navbar.
 *
 * Shows the theme you would switch TO, which is the convention people expect
 * from a single-button toggle: a moon means "go dark". The label says so
 * explicitly, because an icon alone is not an accessible name.
 */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const goingTo = theme === "dark" ? "light" : "dark";

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${goingTo} mode`}
      title={`Switch to ${goingTo} mode`}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-surface-700 text-surface-400 transition-colors hover:border-orchid-400/50 hover:text-orchid-400"
    >
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-[18px] w-[18px]"
      >
        {theme === "dark" ? (
          // Currently dark → offer the sun.
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : (
          // Currently light → offer the moon.
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        )}
      </svg>
    </button>
  );
}
