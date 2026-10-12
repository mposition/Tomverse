import type { Metadata } from "next";

/**
 * Tomverse Review remains private to search engines even though it now has a
 * canonical product URL.
 */
export const metadata: Metadata = {
  title: "Tomverse Review",
  robots: { index: false, follow: false, nocache: true },
};

export default function ReviewLayout({ children }: { children: React.ReactNode }) {
  return children;
}
