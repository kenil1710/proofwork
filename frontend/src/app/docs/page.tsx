import type { Metadata } from "next";
import { DocsShell } from "@/components/docs/DocsShell";

export const metadata: Metadata = {
  title: "Docs — ProofWork",
  description:
    "How ProofWork works: writing requirements, submitting evidence, how scoring and payouts are decided, and what reputation records.",
};

export default function DocsPage() {
  return <DocsShell />;
}
