import { CONTRACT_ADDRESS, IS_GASLESS, chain, explorerUrl } from "@/lib/genlayer";

// The faucet is Bradbury-only. Studio networks are gasless, so linking it there
// sends people to claim tokens they neither need nor can get for that chain.
const LINKS = [
  { label: "App", href: "/app", external: false },
  { label: "Docs", href: "/docs", external: false },
  { label: "GitHub", href: "https://github.com/genlayerlabs", external: true },
  { label: "X", href: "https://x.com/GenLayer", external: true },
  ...(IS_GASLESS
    ? []
    : [{ label: "Faucet", href: "https://testnet-faucet.genlayer.foundation", external: true }]),
] as const;

export function Footer() {
  return (
    <footer className="chrome-footer border-t border-surface-800">
      <div className="mx-auto grid w-full max-w-6xl gap-8 px-6 py-12 sm:grid-cols-[1.5fr_1fr]">
        <div>
          <p className="text-sm text-surface-300">
            Proof<span className="text-orchid-400">Work</span>
          </p>
          <p className="mt-3 max-w-md text-sm leading-relaxed text-surface-500">
            Get paid on the evidence, not the argument. Freelance escrow settled
            by validator consensus on GenLayer — running on {chain.name}, where
            GEN is testnet-only and has no real-world value.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:items-end">
          <nav className="flex flex-wrap gap-x-6 gap-y-2">
            {LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                {...(link.external
                  ? { target: "_blank", rel: "noreferrer" }
                  : {})}
                className="text-xs tracking-[0.14em] text-surface-400 uppercase transition-colors hover:text-orchid-300"
              >
                {link.label}
              </a>
            ))}
          </nav>

          <a
            href={explorerUrl("address", CONTRACT_ADDRESS)}
            target="_blank"
            rel="noreferrer"
            className="value-mono text-xs break-all text-surface-600 transition-colors hover:text-orchid-400 sm:text-right"
          >
            {CONTRACT_ADDRESS}
          </a>
        </div>
      </div>
    </footer>
  );
}
