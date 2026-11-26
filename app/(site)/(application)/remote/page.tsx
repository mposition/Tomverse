import type { Metadata } from "next";
import { getServerSession } from "next-auth/next";
import { notFound, redirect } from "next/navigation";
import { DesktopRemoteWorkspace } from "@/components/remote/DesktopRemoteWorkspace";
import { authOptions } from "@/lib/auth";
import { desktopRemoteControlEnabled } from "@/lib/nativeBearerGate";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your PCs",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * Remote control of the account's Tomverse Desktop PCs from a phone or another computer
 * (docs/ops/desktop-remote-control.md). Not found while the server switch is off; the session and every action are
 * checked again by the API routes.
 */
export default async function DesktopRemotePage() {
  if (!desktopRemoteControlEnabled()) notFound();
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect(`/auth/signin?${new URLSearchParams({ callbackUrl: "/remote" })}`);
  return <DesktopRemoteWorkspace />;
}
