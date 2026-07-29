import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { AdminConsoleShell } from "@/components/admin/AdminConsoleShell";
import { authOptions } from "@/lib/auth";
import { getAdminRole, getAdminSessionAccessState } from "@/lib/adminAuth";
import { adminReauthenticationHref } from "@/lib/adminReauthenticationCore";
import { prisma } from "@/lib/prisma";
import { getScheduledJobsDashboard } from "@/lib/scheduledJobs";

export const metadata: Metadata = {
  title: "Administration",
  robots: { index: false, follow: false, nocache: true },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) redirect("/auth/signin?callbackUrl=/admin/overview");
  const accessState = getAdminSessionAccessState(session);
  if (accessState === "not-authorized") notFound();
  if (accessState === "reauthentication-required") {
    const requestHeaders = await headers();
    redirect(
      adminReauthenticationHref(
        requestHeaders.get("x-tomverse-pathname") || "/admin/overview"
      )
    );
  }
  const role = getAdminRole(session) || "readonly";
  const [jobsResult, alertsResult] = await Promise.allSettled([
    getScheduledJobsDashboard(),
    prisma.adminNotificationLog.count({
      where: { status: "failed", acknowledgedAt: null },
    }),
  ]);
  const delayedJobCount =
    jobsResult.status === "fulfilled"
      ? jobsResult.value.filter((job) => job.delayed || job.status === "stuck").length
      : null;
  const apiStatus =
    jobsResult.status === "fulfilled" && alertsResult.status === "fulfilled"
      ? "healthy"
      : "degraded";
  const environment = (
    process.env.RAILWAY_ENVIRONMENT_NAME ||
    process.env.NEXT_PUBLIC_APP_ENV ||
    process.env.NODE_ENV ||
    "unknown"
  ).toUpperCase();
  const version = (
    process.env.RAILWAY_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_APP_VERSION ||
    "local"
  ).slice(0, 12);

  return (
    <AdminConsoleShell
      role={role}
      user={{
        name: session.user.name || null,
        email: session.user.email || null,
        image: session.user.image || null,
      }}
      environment={environment}
      version={version}
      apiStatus={apiStatus}
      delayedJobCount={delayedJobCount}
      unacknowledgedAlertCount={alertsResult.status === "fulfilled" ? alertsResult.value : null}
    >
      {children}
    </AdminConsoleShell>
  );
}
