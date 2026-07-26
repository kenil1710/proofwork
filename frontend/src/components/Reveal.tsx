"use client";

import { useEffect, useRef, useState } from "react";
import { useSkipAnimation } from "@/hooks/useSkipAnimation";

/**
 * Fades content up as it scrolls into view.
 *
 * Two things it deliberately gets right, because the failure mode is content
 * that never appears rather than content that animates badly:
 *
 *  - It disconnects after the first intersection. Re-animating on every scroll
 *    past is the kind of effect that makes a page feel restless.
 *  - If IntersectionObserver is missing or the user asked for reduced motion,
 *    the element is shown immediately rather than left in its hidden start
 *    state — see `useSkipAnimation`.
 */
export function Reveal({
  children,
  delayMs = 0,
  className = "",
  as: Tag = "div",
}: {
  children: React.ReactNode;
  /** Stagger within a group. Keep under ~200ms; longer reads as lag. */
  delayMs?: number;
  className?: string;
  as?: "div" | "section" | "li" | "article";
}) {
  const ref = useRef<HTMLElement | null>(null);
  const [observed, setObserved] = useState(false);
  const skip = useSkipAnimation();

  // Derived, not stored: when animation is skipped there is nothing to wait
  // for, so the element is simply shown. Keeping this out of state is what
  // avoids a synchronous setState in the effect below, which React 19 treats
  // as an error rather than a warning.
  const shown = skip || observed;

  useEffect(() => {
    const node = ref.current;
    if (!node || skip) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setObserved(true);
            observer.disconnect();
          }
        }
      },
      // Fire a little before the element reaches the viewport edge, so the
      // motion has finished by the time it is properly on screen.
      { rootMargin: "0px 0px -10% 0px", threshold: 0.05 },
    );

    observer.observe(node);

    // Safety net. An IntersectionObserver that never fires leaves the element
    // at opacity 0 permanently — content silently missing from the page, which
    // is far worse than an animation that does not play. Observed for real:
    // the hero's call-to-action buttons rendered with correct markup and
    // styles but stayed invisible because their callback never ran.
    //
    // Scoped to elements that are *actually on screen* by the time it fires.
    // Revealing everything unconditionally would show the whole page at once
    // and defeat the scroll reveal; this only rescues the case that goes
    // wrong, which is content sitting in the viewport that was never told.
    const failsafe = window.setTimeout(() => {
      const rect = node.getBoundingClientRect();
      const onScreen =
        rect.top < (window.innerHeight || 0) && rect.bottom > 0;
      if (onScreen) {
        setObserved(true);
        observer.disconnect();
      }
    }, 1200);

    return () => {
      observer.disconnect();
      window.clearTimeout(failsafe);
    };
  }, [skip]);

  return (
    <Tag
      ref={ref as never}
      className={`reveal ${shown ? "reveal-in" : ""} ${className}`}
      style={shown && delayMs ? { transitionDelay: `${delayMs}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}
