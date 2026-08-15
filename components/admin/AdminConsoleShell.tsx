"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bell, Loader2, Menu, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AppToastViewport } from "@/components/AppToastViewport";
import { AdminAccountMenu } from "@/components/admin/AdminAccountMenu";
import {
  AdminConsolePreferencesProvider,
  useAdminConsolePreferences,
} from "@/components/admin/AdminConsolePreferences";
import { AdminCommandPalette } from "@/components/admin/AdminCommandPalette";
import { AdminSidebar } from "@/components/admin/AdminSidebar";
import {
  adminItemIsWritable,
  findAdminNavItem,
  resolveAdminPageMeta,
} from "@/lib/adminNavigation";
import type { AdminNavigationCounts } from "@/lib/adminNavigationBadges";
import type { AdminRole } from "@/lib/adminAuthCore";

/**
 * The automatic-refresh period, and the only place it is written down.
 *
 * The button used to read "Auto 60s" while the interval was 180000ms, so the
 * console told operators it was three times fresher than it was. Label and
 * timer now derive from this constant, which is the only way the two cannot
 * drift apart again.
 */
export const ADMIN_AUTO_REFRESH_INTERVAL_MS = 180_000;
export const ADMIN_AUTO_REFRESH_LABEL = `Auto ${Math.round(
  ADMIN_AUTO_REFRESH_INTERVAL_MS / 60_000
)}m`;

type NotificationRow = {
  id: string;
  title: string;
  detail: string | null;
  status: string;
  createdAt: string;
};

type Props = {
  children: React.ReactNode;
  role: AdminRole;
  user: { name: string | null; email: string | null; image: string | null };
  environment: string;
  version: string;
  apiStatus: "healthy" | "degraded" | "unknown";
  counts: AdminNavigationCounts;
};

const statusTone = (status: Props["apiStatus"]) =>
  status === "healthy"
    ? "text-emerald-300"
    : status === "degraded"
      ? "text-amber-300"
      : "text-zinc-500";

export function AdminConsoleShell(props: Props) {
  return (
    <AdminConsolePreferencesProvider>
      <AdminConsoleChrome {...props} />
    </AdminConsolePreferencesProvider>
  );
}

function AdminConsoleChrome({
  children,
  role,
  user,
  environment,
  version,
  apiStatus,
  counts,
}: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const { isPinned, togglePin } = useAdminConsolePreferences();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [drawerOpenCount, setDrawerOpenCount] = useState(0);
  const [commandOpen, setCommandOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [notificationRows, setNotificationRows] = useState<NotificationRow[]>([]);
  const [loadingAlerts, setLoadingAlerts] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Starts empty rather than at `new Date()`. This component is server-rendered
  // before it is hydrated, so a clock read during render gives the two renders
  // two different seconds, and React answers that mismatch by re-rendering the
  // whole tree on the client. When that recovery happens while the Suspense
  // boundary from `admin/loading.tsx` is still streaming, the streamed copy of
  // the page is left behind in the document and every control on the page
  // exists twice. The reading is a client-side one anyway: it means "when this
  // browser last refreshed", which the server cannot know.
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const page = resolveAdminPageMeta(pathname);
  const activeItem = findAdminNavItem(pathname);
  const pageWritable = activeItem
    ? adminItemIsWritable(role, activeItem)
    : role === "owner";
  const pinnable = Boolean(activeItem) || page.href === "/admin/search";
  const pinnedNow = isPinned(page.href);

  const refresh = useCallback(
    (source: "manual" | "automatic") => {
      setRefreshing(true);
      router.refresh();
      window.dispatchEvent(new CustomEvent("admin:refresh", { detail: { source } }));
      setLastUpdated(new Date());
      window.setTimeout(() => setRefreshing(false), 650);
    },
    [router]
  );

  useEffect(() => {
    queueMicrotask(() => setLastUpdated(new Date()));
  }, [pathname]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
      if (event.key === "Escape") {
        setCommandOpen(false);
        setAlertsOpen(false);
        setMobileNavOpen(false);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = window.setInterval(
      () => refresh("automatic"),
      ADMIN_AUTO_REFRESH_INTERVAL_MS
    );
    return () => window.clearInterval(interval);
  }, [autoRefresh, refresh]);

  const loadAlerts = async () => {
    setAlertsOpen((open) => !open);
    if (notificationRows.length > 0 || loadingAlerts) return;
    setLoadingAlerts(true);
    try {
      const response = await fetch("/api/admin/notifications?take=5&status=all", {
        cache: "no-store",
      });
      const data = (await response.json().catch(() => null)) as
        | { logs?: NotificationRow[] }
        | null;
      if (response.ok) setNotificationRows(data?.logs || []);
    } finally {
      setLoadingAlerts(false);
    }
  };

  const openDrawer = () => {
    setMobileNavOpen(true);
    setDrawerOpenCount((count) => count + 1);
  };

  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-100">
      {/*
        Every admin panel reports through dispatchAppToast(). The console had
        no listener, so validation failures, API errors and confirmations were
        dispatched into nothing. Mounted here rather than in the shared
        `(application)` layout: /chat renders its own listener and would show
        every toast twice.
      */}
      <AppToastViewport />
      <aside className="fixed inset-y-0 left-0 z-50 hidden w-64 border-r border-zinc-800 lg:block">
        <AdminSidebar
          pathname={pathname}
          role={role}
          counts={counts}
          variant="rail"
        />
      </aside>
      {mobileNavOpen ? (
        <div className="fixed inset-0 z-[70] lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/70"
            aria-label="Close navigation"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="relative h-full w-[min(20rem,88vw)] border-r border-zinc-800 shadow-2xl">
            <AdminSidebar
              pathname={pathname}
              role={role}
              counts={counts}
              variant="drawer"
              revealToken={drawerOpenCount}
              onNavigate={() => setMobileNavOpen(false)}
            />
          </aside>
        </div>
      ) : null}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur-xl">
          {/*
            Tighter gutters and gaps below `sm`. The header now carries one
            more control than it used to, and at 320px with a 200% root font
            every spacing unit is doubled too -- so the space the account menu
            needs is taken from the padding rather than from the menu, which
            would have to shrink below a usable touch target to pay for it.
          */}
          <div className="flex h-16 items-center gap-2 px-3 sm:gap-3 sm:px-6">
            <button
              type="button"
              onClick={openDrawer}
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-800 lg:hidden"
              aria-label="Open admin navigation"
            >
              <Menu className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setCommandOpen(true)}
              className="flex min-w-0 max-w-xl flex-1 items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-left text-sm text-zinc-400 hover:border-zinc-700"
              aria-label="Open global search and command palette"
            >
              <Search className="h-4 w-4" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                Search customers, refunds, traces, or commands
              </span>
              <kbd className="hidden rounded border border-zinc-700 px-1.5 py-0.5 text-xs font-bold text-zinc-400 sm:inline">
                Ctrl K
              </kbd>
            </button>
            <span
              className={`hidden rounded-full border px-2.5 py-1 text-xs font-black uppercase tracking-[0.14em] sm:inline-flex ${
                environment.toLowerCase() === "production"
                  ? "border-red-500/30 bg-red-500/10 text-red-200"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-200"
              }`}
            >
              {environment}
            </span>
            <div className="relative">
              <button
                type="button"
                onClick={() => void loadAlerts()}
                className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-800 hover:bg-zinc-900"
                aria-label="Open notification center"
                aria-expanded={alertsOpen}
              >
                <Bell className="h-4 w-4" aria-hidden />
                {counts.failedAlerts && counts.failedAlerts > 0 ? (
                  <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500" />
                ) : null}
              </button>
              {alertsOpen ? (
                <div className="absolute right-0 top-12 z-50 w-[min(24rem,calc(100vw-2rem))] rounded-2xl border border-zinc-800 bg-zinc-950 p-3 shadow-2xl">
                  <div className="flex items-center justify-between px-1 pb-2">
                    <p className="text-sm font-bold text-white">Notification center</p>
                    <Link
                      href="/admin/alerts?tab=deliveries"
                      onClick={() => setAlertsOpen(false)}
                      className="text-xs font-bold text-blue-300"
                    >
                      View all
                    </Link>
                  </div>
                  {loadingAlerts ? (
                    <Loader2 className="mx-auto my-6 h-5 w-5 animate-spin text-zinc-500" />
                  ) : notificationRows.length === 0 ? (
                    <p className="rounded-xl border border-zinc-800 bg-zinc-900 p-3 text-xs text-zinc-400">
                      No notification records.
                    </p>
                  ) : (
                    notificationRows.map((item) => (
                      <div
                        key={item.id}
                        className="mb-1 rounded-xl border border-zinc-800 bg-zinc-900/70 p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-xs font-bold text-zinc-100">
                            {item.title}
                          </p>
                          <span
                            className={`text-xs font-bold uppercase ${
                              item.status === "failed"
                                ? "text-red-300"
                                : "text-emerald-300"
                            }`}
                          >
                            {item.status}
                          </span>
                        </div>
                        {item.detail ? (
                          <p className="mt-1 line-clamp-2 text-xs text-zinc-400">
                            {item.detail}
                          </p>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              ) : null}
            </div>
            {/*
              Not `hidden md:flex` any more. This was a label, so on a phone
              the console had neither a sign-out nor a way back to the app --
              and "sign out completely, then sign in again" is the only
              instruction that clears an expired administrator window.
            */}
            <AdminAccountMenu
              user={{ name: user.name, email: user.email }}
              role={role}
            />
          </div>
        </header>

        <main className="min-h-[calc(100dvh-7.5rem)] px-4 py-5 sm:px-6">
          <div className="mx-auto w-full max-w-[104rem]">
            <div className="mb-5 flex flex-col gap-4 border-b border-zinc-800 pb-5 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2 text-xs font-bold text-zinc-500">
                  <Link href="/admin/overview" className="hover:text-zinc-300">
                    Admin Console
                  </Link>
                  <span aria-hidden>/</span>
                  {page.parentLabel && page.parentHref ? (
                    <>
                      <Link href={page.parentHref} className="hover:text-zinc-300">
                        {page.parentLabel}
                      </Link>
                      <span aria-hidden>/</span>
                    </>
                  ) : null}
                  <span className="text-zinc-300">{page.label}</span>
                </div>
                <h1 className="mt-2 text-2xl font-black tracking-tight text-white sm:text-3xl">
                  {page.label}
                </h1>
                <p className="mt-1 text-sm text-zinc-400">{page.description}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!pageWritable ? (
                  <span className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-bold text-zinc-300">
                    Read-only for {role}
                  </span>
                ) : null}
                {pinnable ? (
                  <button
                    type="button"
                    onClick={() => togglePin(page.href)}
                    aria-pressed={pinnedNow}
                    className={`rounded-xl border px-3 py-2 text-xs font-bold ${
                      pinnedNow
                        ? "border-blue-500/40 bg-blue-500/10 text-blue-200"
                        : "border-zinc-800 text-zinc-300 hover:bg-zinc-900"
                    }`}
                  >
                    {pinnedNow ? "Pinned" : "Pin page"}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setAutoRefresh((value) => !value)}
                  className={`rounded-xl border px-3 py-2 text-xs font-bold ${
                    autoRefresh
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                      : "border-zinc-800 text-zinc-300"
                  }`}
                  aria-pressed={autoRefresh}
                >
                  {autoRefresh ? ADMIN_AUTO_REFRESH_LABEL : "Manual refresh"}
                </button>
                <button
                  type="button"
                  onClick={() => refresh("manual")}
                  className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-bold text-white hover:bg-zinc-800"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
                    aria-hidden
                  />{" "}
                  Refresh
                </button>
                <span className="text-xs text-zinc-500">
                  Updated{" "}
                  {lastUpdated
                    ? `${lastUpdated.toISOString().slice(11, 19)} UTC`
                    : "--:--:-- UTC"}
                </span>
              </div>
            </div>
            {children}
          </div>
        </main>

        <footer className="border-t border-zinc-800 bg-[#08090c] px-4 py-3 text-xs text-zinc-400 sm:px-6">
          <div className="mx-auto flex max-w-[104rem] flex-wrap items-center gap-x-5 gap-y-2">
            <span className="font-black uppercase tracking-[0.14em] text-zinc-300">
              {environment}
            </span>
            <span
              className={
                counts.delayedJobs && counts.delayedJobs > 0
                  ? "text-amber-300"
                  : "text-emerald-300"
              }
            >
              Job health:{" "}
              {counts.delayedJobs === null
                ? "Unknown"
                : counts.delayedJobs > 0
                  ? `${counts.delayedJobs} delayed`
                  : "Healthy"}
            </span>
            <span className={statusTone(apiStatus)}>API/DB: {apiStatus}</span>
            <span>Version {version}</span>
            <span className="ml-auto">Role: {role}</span>
          </div>
        </footer>
      </div>

      {/* Mounted only while open: its state is per-session, not persistent. */}
      {commandOpen ? (
        <AdminCommandPalette onClose={() => setCommandOpen(false)} />
      ) : null}
    </div>
  );
}
