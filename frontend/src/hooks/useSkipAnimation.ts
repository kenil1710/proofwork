"use client";

import { useSyncExternalStore } from "react";

/**
 * True when animation should be skipped entirely and content shown at once.
 *
 * Covers two cases that want identical handling: the user asked for reduced
 * motion, or the browser has no IntersectionObserver so nothing would ever
 * trigger the reveal.
 *
 * `useSyncExternalStore` rather than a mount effect. This is genuinely external
 * state — a media query the browser owns and can change under us — and reading
 * it this way both keeps it live and satisfies React 19's
 * `set-state-in-effect` rule, which treats a synchronous setState in an effect
 * body as an error.
 *
 * The server snapshot is `false` (animate). Rendering the animated start state
 * on the server means a reduced-motion user sees content appear instantly on
 * hydration rather than watching it fade — and CSS already forces `.reveal`
 * visible under `prefers-reduced-motion`, so nothing can get stuck hidden.
 */
const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined") return false;
  const reduced = window.matchMedia?.(QUERY).matches === true;
  const noObserver = typeof IntersectionObserver === "undefined";
  return reduced || noObserver;
}

function getServerSnapshot(): boolean {
  return false;
}

export function useSkipAnimation(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
