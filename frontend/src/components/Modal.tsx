"use client";

import { useEffect, useRef } from "react";

/**
 * Base dialog: backdrop, Escape to close, focus moved in and restored on close.
 *
 * `dismissible` is false while a transaction is in flight. Closing the dialog
 * would not cancel the transaction — it would only hide it — so the escape
 * hatches are removed rather than left there implying they stop anything.
 */
export function Modal({
  open,
  onClose,
  labelledBy,
  dismissible = true,
  children,
}: {
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  dismissible?: boolean;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    restoreTo.current = document.activeElement as HTMLElement | null;
    // Focus the panel so the next Tab lands inside the dialog rather than
    // continuing down the page behind it.
    panelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissible) onClose();
    };
    document.addEventListener("keydown", onKeyDown);

    // Stop the page scrolling under the backdrop.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreTo.current?.focus?.();
    };
  }, [open, onClose, dismissible]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div
        aria-hidden
        onClick={dismissible ? onClose : undefined}
        className="absolute inset-0 bg-surface-950/80 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className="relative w-full max-w-lg rounded-[16px] border border-surface-700 bg-surface-900 p-6 outline-none sm:p-8"
      >
        {children}
      </div>
    </div>
  );
}
