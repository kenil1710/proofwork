"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { DOC_SECTIONS } from "@/components/docs/sections";

/**
 * Docs chrome: sidebar navigation, search, and scroll-spy.
 *
 * Search filters the *sections*, not the words inside them. Matching individual
 * sentences and scrolling to a highlight sounds better than it reads — these
 * sections are short, and "which page answers this" is the actual question
 * someone has. Matching also covers a keyword list per section, so "money" or
 * "wallet" find the right page even though neither word is a heading.
 */
export function DocsShell() {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState(DOC_SECTIONS[0].id);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const normalised = query.trim().toLowerCase();

  const matches = useMemo(() => {
    if (!normalised) return DOC_SECTIONS;
    return DOC_SECTIONS.filter((section) =>
      `${section.title} ${section.navLabel} ${section.keywords}`
        .toLowerCase()
        .includes(normalised),
    );
  }, [normalised]);

  // Highlight the section currently under the top of the viewport. Only runs
  // when nothing is filtered, since a filtered list has its own meaning.
  useEffect(() => {
    if (normalised) return;
    const root = contentRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;

    const headings = Array.from(
      root.querySelectorAll<HTMLElement>("section[id]"),
    );
    if (!headings.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]?.target.id) setActiveId(visible[0].target.id);
      },
      // A band near the top of the viewport: whatever crosses it is what the
      // reader is on.
      { rootMargin: "-80px 0px -70% 0px", threshold: 0 },
    );

    for (const heading of headings) observer.observe(heading);
    return () => observer.disconnect();
  }, [normalised]);

  const visible = new Set(matches.map((section) => section.id));

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-12">
      <Breadcrumbs trail={[{ label: "ProofWork", href: "/" }, { label: "Docs" }]} />

      <div className="grid gap-12 lg:grid-cols-[240px_1fr] lg:gap-16">
        {/* ── Sidebar ──────────────────────────────────────────────────── */}
        <aside className="lg:sticky lg:top-8 lg:self-start">
          <label htmlFor="docs-search" className="sr-only">
            Search the documentation
          </label>
          <input
            id="docs-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search docs…"
            className="input w-full"
          />

          <nav aria-label="Documentation" className="mt-6">
            {matches.length === 0 ? (
              <p className="text-sm leading-relaxed text-surface-500">
                Nothing matches &ldquo;{query.trim()}&rdquo;. Try a broader word
                — the pages cover posting jobs, submitting evidence, scoring and
                reputation.
              </p>
            ) : (
              <ul className="space-y-1">
                {matches.map((section) => {
                  const active = !normalised && activeId === section.id;
                  return (
                    <li key={section.id}>
                      <a
                        href={`#${section.id}`}
                        aria-current={active ? "location" : undefined}
                        className={`block border-l-2 py-1.5 pl-3 text-sm transition-colors ${
                          active
                            ? "border-orchid-400 text-surface-100"
                            : "border-surface-800 text-surface-400 hover:border-surface-600 hover:text-surface-200"
                        }`}
                      >
                        {section.navLabel}
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </nav>

          {normalised && matches.length > 0 ? (
            <p className="mt-4 text-xs text-surface-600">
              {matches.length} of {DOC_SECTIONS.length} pages
            </p>
          ) : null}
        </aside>

        {/* ── Content ──────────────────────────────────────────────────── */}
        <div ref={contentRef} className="min-w-0">
          <header className="border-b border-surface-800 pb-8">
            <p className="eyebrow text-orchid-400">
              Documentation
            </p>
            <h1 className="title-display mt-4 text-surface-100">
              How ProofWork works
            </h1>
            <p className="mt-4 max-w-2xl leading-relaxed text-surface-400">
              What to write, what to submit, and how a score turns into a
              payment.
            </p>
          </header>

          {DOC_SECTIONS.filter((section) => visible.has(section.id)).map(
            (section) => (
              <section
                key={section.id}
                id={section.id}
                className="scroll-mt-8 border-b border-surface-800 py-12 last:border-0"
              >
                <h2 className="text-2xl font-semibold tracking-tight text-surface-100">
                  {section.title}
                </h2>
                {section.body}
              </section>
            ),
          )}
        </div>
      </div>
    </main>
  );
}
