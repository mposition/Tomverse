import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { AdminReauthenticationCard } from "@/components/admin/AdminReauthenticationCard";
import { authOptions } from "@/lib/auth";
import { getAdminSessionAccessState } from "@/lib/adminAuth";
import { normalizeAdminCallbackPath } from "@/lib/adminReauthenticationCore";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Administrator reauthentication",
  robots: { index: false, follow: false, nocache: true },
};

export default async function AdminReauthenticatePage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string | string[] }>;
}) {
  const params = await searchParams;
  const callbackUrl = normalizeAdminCallbackPath(
    Array.isArray(params.callbackUrl) ? params.callbackUrl[0] : params.callbackUrl
  );
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    redirect(`/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  const accessState = getAdminSessionAccessState(session);
  if (accessState === "not-authorized") notFound();
  if (accessState === "authorized") redirect(callbackUrl);

  return (
    <AdminReauthenticationCard
      callbackUrl={callbackUrl}
      email={session.user.email || null}
    />
  );
}
