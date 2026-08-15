import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { AdminReauthenticationCard } from "@/components/admin/AdminReauthenticationCard";
import { authOptions } from "@/lib/auth";
import { getAdminSessionAccessState } from "@/lib/adminAuth";
import { hasRecentAdminAuthentication } from "@/lib/adminReauthentication";
import {
  normalizeAdminReauthenticationMode,
  resolveAdminReauthenticationView,
} from "@/lib/adminReauthenticationCore";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Administrator reauthentication",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * The screen both administrator authentication windows land on.
 *
 * It used to answer only the console-session question -- an authorized session
 * was redirected straight to the callback -- so an operator whose 30-minute
 * step-up window had expired inside a valid 8-hour console session was sent
 * back to the page that had just refused their save, with no way out but to
 * guess that a full sign-out was required. `?mode=recent` is how a high-risk
 * action says which window it means; the decision itself lives in
 * `resolveAdminReauthenticationView` so the whole matrix is unit-tested.
 */
export default async function AdminReauthenticatePage({
  searchParams,
}: {
  searchParams: Promise<{
    callbackUrl?: string | string[];
    mode?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const session = await getServerSession(authOptions);
  const view = resolveAdminReauthenticationView({
    signedIn: Boolean(session?.user?.id),
    accessState: getAdminSessionAccessState(session),
    mode: normalizeAdminReauthenticationMode(params.mode),
    // Read through the shared server helper, which is the only reader of
    // ADMIN_RECENT_AUTH_MINUTES for this decision, so a production override
    // moves the page and `/api/admin/**` together.
    hasRecentAuthentication: hasRecentAdminAuthentication(session),
    callbackUrl: params.callbackUrl,
  });

  if (view.kind === "not-found") notFound();
  if (view.kind === "sign-in" || view.kind === "callback") redirect(view.href);

  return (
    <AdminReauthenticationCard
      callbackUrl={view.callbackUrl}
      reason={view.reason}
      email={session?.user?.email || null}
    />
  );
}
