import type { Metadata } from "next";

/**
 * Same metadata as `/chat`, including `noindex`.
 *
 * Deliberate rather than incidental: two indexable URLs serving the identical
 * workspace would be a duplicate-content problem, and this alias exists to be
 * ready, not to be found. The Search Console baseline the rename runbook asks
 * for (docs/ops/tomverse-review-rename.md §5.1) is measured against `/chat`
 * while that is still the path users reach.
 */
export const metadata: Metadata = {
  title: "AI Workspace",
  robots: { index: false, follow: false, nocache: true },
};

export default function ReviewLayout({ children }: { children: React.ReactNode }) {
  return children;
}
