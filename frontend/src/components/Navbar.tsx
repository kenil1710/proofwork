"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AddNetworkButton } from "./AddNetworkButton";
import { ConnectWallet } from "./ConnectWallet";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/app", label: "App" },
  { href: "/docs", label: "Docs" },
  { href: "/reputation", label: "Reputation" },
] as const;

/**
 * Header, rendered once in layout.tsx so it survives navigation.
 *
 * A client component only because the active link needs `usePathname`. The
 * wallet button brings its own boundary either way, so this costs nothing
 * beyond the pathname subscription.
 *
 * Two rows on mobile, one from `sm` up. A single row could not hold three links
 * plus the wallet button at 390px: the row refused to shrink, pushed the page
 * wider than the viewport, and every section below inherited a horizontal
 * scrollbar with its body text clipped. Wrapping fixes it at the cause rather
 * than hiding it with `overflow-x`.
 */
export function Navbar() {
  const pathname = usePathname();

  return (
    <header className="chrome-nav sticky top-0 z-20 border-b border-surface-800 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-3 px-6 py-4 sm:flex-nowrap">
        <Link href="/" className="mr-auto flex items-baseline gap-2">
          <span className="text-lg font-semibold tracking-tight text-surface-100">
            Proof
            <span className="text-orchid-400">Work</span>
          </span>
        </Link>

        {/* Wallet sits beside the logo on the first row at every size, because
            it is the control people reach for. The theme switch rides with it
            so the two controls never split across rows on a narrow screen. */}
        <div className="order-2 flex items-center gap-2 sm:order-3">
          {/* Renders nothing unless the wallet is on another chain, so it costs
              no width in the common case — which is what keeps this row inside
              390px. Below `sm` it hides itself and <NetworkBanner> carries the
              same action instead. */}
          <AddNetworkButton />
          <ThemeToggle />
          <ConnectWallet />
        </div>

        {/* Full width below `sm` so it takes its own row; inline after that. */}
        <div className="order-3 flex w-full items-baseline gap-6 sm:order-2 sm:w-auto sm:gap-8">
          {LINKS.map((link) => {
            // "/" would otherwise match every route as a prefix.
            const active =
              link.href === "/"
                ? pathname === "/"
                : pathname.startsWith(link.href);

            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={`text-xs tracking-[0.18em] whitespace-nowrap uppercase transition-colors ${ active ?"text-orchid-400":"text-surface-400 hover:text-orchid-300"}`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </header>
  );
}
