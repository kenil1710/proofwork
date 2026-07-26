import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Footer } from "@/components/Footer";
import { Navbar } from "@/components/Navbar";
import { NetworkBanner } from "@/components/NetworkBanner";
import { ThemeProvider } from "@/components/ThemeProvider";
import { WalletProvider } from "@/components/WalletProvider";
import "./globals.css";

// One face for everything a person reads: headings, body, buttons, labels.
// Geist is a neutral modern grotesque — it carries a 6rem hero and a 12px
// label without changing character, which is what lets a single family cover
// the whole site.
const geistSans = Geist({
  variable: "--font-geist-sans",
  // 800 is here for the hero only. Below ~3rem it is too heavy and 600/700
  // does the work.
  weight: ["400", "500", "600", "700", "800"],
  subsets: ["latin"],
  display: "swap",
});

// Strictly for values a machine emitted and a person may need to compare
// character by character: contract addresses, transaction hashes, chain ids,
// and code. Not for headings, labels, or buttons — mono there is costume, and
// it was making ordinary UI text harder to read than it needed to be.
//
// Geist Mono rather than a mono from another family: addresses sit inline
// beside sans text in the job and network grids, and a matched pair keeps the
// x-height and colour consistent across that boundary.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  weight: ["400", "500"],
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "ProofWork — AI-Verified Freelance Escrow",
  description:
    "Trustless freelance escrow on GenLayer, where AI validators verify deliverables against the agreed requirements.",
};

/**
 * Applies the saved theme before the first paint.
 *
 * This runs synchronously in <head>, ahead of any rendering, so the correct
 * class is on <html> by the time the body is painted — that is what prevents
 * the flash of the wrong theme. It deliberately does NOT go through React:
 * anything that waits for hydration is, by definition, too late.
 *
 * Reading the cookie here rather than with `cookies()` in this layout is a
 * deliberate trade. `cookies()` would opt every route into dynamic rendering,
 * and this site's pages are all statically prerendered — the landing page in
 * particular reads nothing at request time on purpose. A 200-byte blocking
 * script buys the same result and keeps the static output.
 *
 * Dark is the default: no cookie, or an unrecognised value, means dark.
 */
const NO_FLASH = `(function(){try{var m=document.cookie.match(/(?:^|;\\s*)pw-theme=(dark|light)/);var t=m?m[1]:"dark";var r=document.documentElement;r.classList.remove("dark","light");r.classList.add(t);r.style.colorScheme=t;}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // Server-rendered as `dark`, the default. The script above corrects it
    // before paint when the cookie says otherwise; ThemeProvider then reads the
    // applied class back out of the DOM rather than guessing.
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      // The script rewrites this class, so React's hydration check would
      // otherwise flag a mismatch it cannot win.
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
      </head>
      <body className="min-h-full flex flex-col">
        {/* Provider wraps the chrome too, so the header reads the same account. */}
        <ThemeProvider>
          <WalletProvider>
            <Navbar />
            {/* Above the page content on every route: a write signed on the
                wrong chain never reaches the contract, and the error it raises
                blames the RPC rather than the network. */}
            <NetworkBanner />
            {children}
            <Footer />
          </WalletProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
