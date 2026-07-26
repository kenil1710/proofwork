"use client";

import { createContext, useCallback, useContext, useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

/** Cookie, not localStorage. Kept in sync with the inline script in layout.tsx
 *  — if you rename it, rename it there too or the no-flash pass breaks. */
export const THEME_COOKIE = "pw-theme";

/**
 * The applied theme lives on `<html>`, put there by the blocking script in
 * layout.tsx before first paint. That element — not React state — is the
 * source of truth, so this is an external store and `useSyncExternalStore` is
 * the right primitive for it.
 *
 * The obvious alternative, `useState` seeded in an effect, is wrong twice
 * over: it renders one frame of the wrong value, and React 19's
 * `set-state-in-effect` rule rejects it outright.
 */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): Theme {
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

/** The server always emits dark — it cannot read the cookie without opting
 *  every route into dynamic rendering. React hydrates against this value and
 *  reconciles to the real one immediately afterwards, so the markup matches
 *  and only the icon settles. The page itself never flashes: the CSS class was
 *  already correct before paint. */
function getServerSnapshot(): Theme {
  return "dark";
}

function applyTheme(next: Theme) {
  const root = document.documentElement;
  root.classList.remove("dark", "light");
  root.classList.add(next);
  root.style.colorScheme = next;
  // A year, root path, Lax: a display preference needs no cross-site exposure
  // and nothing about it is sensitive.
  document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
  listeners.forEach((notify) => notify());
}

type ThemeContextValue = { theme: Theme; toggle: () => void };

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggle = useCallback(() => {
    applyTheme(getSnapshot() === "dark" ? "light" : "dark");
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used inside <ThemeProvider>.");
  }
  return context;
}
