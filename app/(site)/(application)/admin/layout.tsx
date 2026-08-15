import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getServerSession } from "next-auth/next";
import { AdminConsoleShell } from "@/components/admin/AdminConsoleShell";
import { authOptions } from "@/lib/auth";
import { getAdminRole, getAdminSessionAccessState } from "@/lib/adminAuth";
import { adminReauthenticationHref } from "@/lib/adminReauthenticationCore";
import { getAdminNavigationCounts } from "@/lib/adminNavigationCounts";
import { resolveDeploymentEnvironment } from "@/lib/deploymentEnvironment";

export const metadata: Metadata = {
  title: "Administration",
  robots: { index: false, follow: false, nocache: true },
};

/**
 * The shell, the access check, and the badge counts. Nothing else.
 *
 * Everything a workspace displays is loaded by that workspace's own page, so
 * moving between them re-runs only the counts below -- eight small reads that
 * every route genuinely uses, because they are what the sidebar badges and the
 * footer's health line are made of.
 */
export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
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
  const { counts, healthy } = await getAdminNavigationCounts();

  // The badge an operator reads before acting has to agree with the rules the
  // server is actually applying, so it comes from the same resolver. Its own
  // chain skipped APP_ENV -- the variable staging sets -- and so displayed
  // PRODUCTION to anyone opening the admin console on staging.
  //
  // NEXT_PUBLIC_APP_ENV is deliberately no longer consulted: it is inlined at
  // build time and now shares an answer with lib/securityEnvironment.ts, and a
  // client-visible variable must not be able to move a security rule.
  const environment = resolveDeploymentEnvironment().toUpperCase();
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
      apiStatus={healthy ? "healthy" : "degraded"}
      counts={counts}
    >
      {children}
    </AdminConsoleShell>
  );
}
