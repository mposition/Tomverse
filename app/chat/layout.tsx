import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AI Workspace",
  robots: { index: false, follow: false, nocache: true },
};

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return children;
}
