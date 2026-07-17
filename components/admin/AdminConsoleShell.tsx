"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  BarChart3,
  Bell,
  Bot,
  ChevronDown,
  CircleDollarSign,
  ClipboardCheck,
  Cloud,
  Command,
  CreditCard,
  Database,
  ExternalLink,
  FileClock,
  Gauge,
  KeyRound,
  LifeBuoy,
  ListChecks,
  Loader2,
  Menu,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  TicketPercent,
  UserRound,
  Users,
  Webhook,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AdminRole } from "@/lib/adminAuthCore";

type NavItem = {
  label: string;
  href: string;
  description: string;
  icon: typeof Gauge;
  writeRoles?: AdminRole[];
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

export const ADMIN_CONSOLE_NAVIGATION: NavGroup[] = [
  {
    label: "Command Center",
    items: [
      { label: "Overview", href: "/admin/overview", description: "Operational snapshot", icon: Gauge },
      { label: "Work queue", href: "/admin/work-queue", description: "Actions that need attention", icon: ListChecks },
      { label: "Incidents", href: "/admin/incidents", description: "Provider and service incidents", icon: ShieldAlert, writeRoles: ["owner", "ops"] },
      { label: "Product analytics", href: "/admin/analytics", description: "Activation and conversion funnel", icon: BarChart3 },
    ],
  },
  {
    label: "Customers",
    items: [
      { label: "Users", href: "/admin/users", description: "Accounts, usage, and controls", icon: Users, writeRoles: ["owner", "support"] },
      { label: "Feedback", href: "/admin/feedback", description: "Customer feedback inbox", icon: MessageSquare, writeRoles: ["owner", "support"] },
      { label: "Support", href: "/admin/support", description: "Cases and privacy requests", icon: LifeBuoy, writeRoles: ["owner", "support"] },
    ],
  },
  {
    label: "Revenue",
    items: [
      { label: "Billing", href: "/admin/billing", description: "Plans and price catalog", icon: CreditCard, writeRoles: ["owner", "billing"] },
      { label: "Refunds", href: "/admin/refunds", description: "Refund review queue", icon: RotateCcw, writeRoles: ["owner", "billing"] },
      { label: "Credit ledger", href: "/admin/credit-ledger", description: "Credit movements and debt", icon: CircleDollarSign, writeRoles: ["owner", "billing"] },
      { label: "Promotions", href: "/admin/promotions", description: "Promotion rules and risk", icon: TicketPercent, writeRoles: ["owner", "billing"] },
    ],
  },
  {
    label: "AI Platform",
    items: [
      { label: "Providers", href: "/admin/providers", description: "Availability and balances", icon: Activity, writeRoles: ["owner", "ops"] },
      { label: "Models", href: "/admin/models", description: "Model registry", icon: Bot, writeRoles: ["owner", "ops"] },
      { label: "Usage & cost", href: "/admin/usage-cost", description: "Usage reconciliation", icon: BarChart3, writeRoles: ["owner", "billing", "ops"] },
      { label: "Fallback policies", href: "/admin/fallback-policies", description: "Checks, routing, and recovery", icon: SlidersHorizontal, writeRoles: ["owner", "ops"] },
    ],
  },
  {
    label: "Operations",
    items: [
      { label: "Infrastructure", href: "/admin/infrastructure", description: "Railway, R2, DB, and Prisma", icon: Cloud, writeRoles: ["owner", "ops", "billing"] },
      { label: "Scheduled jobs", href: "/admin/jobs", description: "Cron health and history", icon: FileClock, writeRoles: ["owner", "ops"] },
      { label: "Alerts", href: "/admin/alerts", description: "Policies and delivery log", icon: Bell, writeRoles: ["owner", "ops"] },
      { label: "Webhooks", href: "/admin/webhooks", description: "Webhook delivery and replay", icon: Webhook, writeRoles: ["owner", "ops", "billing"] },
      { label: "Platform settings", href: "/admin/platform", description: "Defaults and emergency kill switches", icon: Settings2, writeRoles: ["owner", "ops"] },
    ],
  },
  {
    label: "Governance",
    items: [
      { label: "Approvals", href: "/admin/approvals", description: "Two-person approval queue", icon: ClipboardCheck, writeRoles: ["owner", "ops", "billing"] },
      { label: "Audit log", href: "/admin/audit", description: "Administrator activity", icon: ShieldCheck },
      { label: "Retention", href: "/admin/retention", description: "Retention and cleanup", icon: Database, writeRoles: ["owner", "ops"] },
      { label: "Admin access", href: "/admin/admin-access", description: "Roles, expiry, and activity", icon: KeyRound, writeRoles: ["owner"] },
    ],
  },
];

const ALL_ITEMS = ADMIN_CONSOLE_NAVIGATION.flatMap((group) => group.items);

type SearchResult = {
  type: string;
  id: string;
  title: string;
  detail: string;
  href: string;
  createdAt: string | null;
};

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
  delayedJobCount: number | null;
  unacknowledgedAlertCount: number | null;
};

const titleFromPath = (pathname: string) => {
  const direct = ALL_ITEMS.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`)
  );
  if (pathname.match(/^\/admin\/users\/[^/]+$/)) {
    return { label: "Customer detail", description: "Account timeline, billing, credits, and security controls", href: "/admin/users", parentLabel: "Users" };
  }
  if (pathname.match(/^\/admin\/providers\/[^/]+$/)) {
    return { label: "Provider detail", description: "Usage diagnostics, billing, fallback, and recent errors", href: "/admin/providers", parentLabel: "Providers" };
  }
  return direct || ALL_ITEMS[0];
};

const canWrite = (role: AdminRole, item: NavItem) =>
  !item.writeRoles || item.writeRoles.includes(role);

const statusTone = (status: Props["apiStatus"]) =>
  status === "healthy"
    ? "text-emerald-300"
    : status === "degraded"
      ? "text-amber-300"
      : "text-zinc-500";

export function AdminConsoleShell({
  children,
  role,
  user,
  environment,
  version,
  apiStatus,
  delayedJobCount,
  unacknowledgedAlertCount,
}: Props) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [notificationRows, setNotificationRows] = useState<NotificationRow[]>([]);
  const [loadingAlerts, setLoadingAlerts] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(() => new Date());
  const [recentPaths, setRecentPaths] = useState<string[]>([]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const page = titleFromPath(pathname);
  const activeItem = ALL_ITEMS.find(
    (item) => pathname === item.href || pathname.startsWith(`${item.href}/`)
  );
  const pageWritable = activeItem ? canWrite(role, activeItem) : role === "owner";

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
    let existing: unknown = [];
    try {
      const stored = window.localStorage.getItem("tomverse-admin-recent-routes");
      existing = stored ? (JSON.parse(stored) as unknown) : [];
    } catch {
      existing = [];
    }
    const safe = Array.isArray(existing)
      ? existing.filter((item): item is string => typeof item === "string")
      : [];
    const next = [pathname, ...safe.filter((item) => item !== pathname)].slice(0, 6);
    queueMicrotask(() => setRecentPaths(next));
    try {
      window.localStorage.setItem("tomverse-admin-recent-routes", JSON.stringify(next));
    } catch {
      // Private browsing or storage policies may make local persistence unavailable.
    }
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
    const interval = window.setInterval(() => refresh("automatic"), 60_000);
    return () => window.clearInterval(interval);
  }, [autoRefresh, refresh]);

  useEffect(() => {
    if (!commandOpen) return;
    const normalized = query.trim();
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (normalized.length < 2) {
      queueMicrotask(() => {
        setSearchResults([]);
        setSearching(false);
      });
      return;
    }
    queueMicrotask(() => setSearching(true));
    searchTimer.current = setTimeout(async () => {
      try {
        const response = await fetch(`/api/admin/search?q=${encodeURIComponent(normalized)}&take=6`, { cache: "no-store" });
        const data = (await response.json().catch(() => null)) as { results?: SearchResult[] } | null;
        setSearchResults(response.ok ? data?.results || [] : []);
      } finally {
        setSearching(false);
      }
    }, 220);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [commandOpen, query]);

  const loadAlerts = async () => {
    setAlertsOpen((open) => !open);
    if (notificationRows.length > 0 || loadingAlerts) return;
    setLoadingAlerts(true);
    try {
      const response = await fetch("/api/admin/notifications?take=5&status=all", { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as { logs?: NotificationRow[] } | null;
      if (response.ok) setNotificationRows(data?.logs || []);
    } finally {
      setLoadingAlerts(false);
    }
  };

  const recentItems = useMemo(
    () => recentPaths.map((path) => ({ path, item: titleFromPath(path) })),
    [recentPaths]
  );

  const navigate = (href: string) => {
    setCommandOpen(false);
    setMobileNavOpen(false);
    router.push(href);
  };

  const sidebar = (
    <div className="flex h-full flex-col bg-[#08090c]">
      <div className="border-b border-zinc-800 px-4 py-4">
        <Link href="/admin/overview" className="flex items-center gap-3" onClick={() => setMobileNavOpen(false)}>
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-sm font-black text-white">T</span>
          <span>
            <span className="block text-sm font-black text-white">Tomverse</span>
            <span className="block text-xs font-bold text-blue-300">Admin Console</span>
          </span>
        </Link>
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-4" aria-label="Admin console navigation">
        {ADMIN_CONSOLE_NAVIGATION.map((group) => (
          <div key={group.label} className="mb-5">
            <p className="mb-1.5 px-3 text-[10px] font-black uppercase tracking-[0.18em] text-zinc-600">{group.label}</p>
            <div className="grid gap-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const writable = canWrite(role, item);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileNavOpen(false)}
                    className={`group flex min-h-10 items-center gap-3 rounded-xl px-3 py-2 text-sm font-bold transition ${
                      active ? "bg-blue-600 text-white" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                    }`}
                    title={item.description}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {!writable ? <span className="text-[9px] uppercase tracking-wide opacity-60">Read</span> : null}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="border-t border-zinc-800 p-3">
        <Link href="/chat" className="flex items-center justify-center gap-2 rounded-xl border border-zinc-800 px-3 py-2 text-xs font-bold text-zinc-300 hover:bg-zinc-900">
          Open Tomverse <ExternalLink className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh bg-zinc-950 text-zinc-100">
      <aside className="fixed inset-y-0 left-0 z-50 hidden w-64 border-r border-zinc-800 lg:block">{sidebar}</aside>
      {mobileNavOpen ? (
        <div className="fixed inset-0 z-[70] lg:hidden">
          <button type="button" className="absolute inset-0 bg-black/70" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />
          <aside className="relative h-full w-[min(20rem,88vw)] border-r border-zinc-800 shadow-2xl">{sidebar}</aside>
        </div>
      ) : null}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur-xl">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
            <button type="button" onClick={() => setMobileNavOpen(true)} className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-800 lg:hidden" aria-label="Open admin navigation">
              <Menu className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => setCommandOpen(true)} className="flex min-w-0 max-w-xl flex-1 items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-left text-sm text-zinc-500 hover:border-zinc-700" aria-label="Open global search and command palette">
              <Search className="h-4 w-4" />
              <span className="min-w-0 flex-1 truncate">Search customers, refunds, traces, or commands</span>
              <kbd className="hidden rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] font-bold text-zinc-500 sm:inline">Ctrl K</kbd>
            </button>
            <span className={`hidden rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.14em] sm:inline-flex ${
              environment.toLowerCase() === "production"
                ? "border-red-500/30 bg-red-500/10 text-red-200"
                : "border-amber-500/30 bg-amber-500/10 text-amber-200"
            }`}>{environment}</span>
            <div className="relative">
              <button type="button" onClick={() => void loadAlerts()} className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-800 hover:bg-zinc-900" aria-label="Open notification center" aria-expanded={alertsOpen}>
                <Bell className="h-4 w-4" />
                {unacknowledgedAlertCount && unacknowledgedAlertCount > 0 ? <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500" /> : null}
              </button>
              {alertsOpen ? (
                <div className="absolute right-0 top-12 z-50 w-[min(24rem,calc(100vw-2rem))] rounded-2xl border border-zinc-800 bg-zinc-950 p-3 shadow-2xl">
                  <div className="flex items-center justify-between px-1 pb-2">
                    <p className="text-sm font-black text-white">Notification center</p>
                    <Link href="/admin/alerts" onClick={() => setAlertsOpen(false)} className="text-xs font-bold text-blue-300">View all</Link>
                  </div>
                  {loadingAlerts ? <Loader2 className="mx-auto my-6 h-5 w-5 animate-spin text-zinc-500" /> : notificationRows.length === 0 ? (
                    <p className="rounded-xl border border-zinc-800 bg-zinc-900 p-3 text-xs text-zinc-500">No notification records.</p>
                  ) : notificationRows.map((item) => (
                    <div key={item.id} className="mb-1 rounded-xl border border-zinc-800 bg-zinc-900/70 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-xs font-black text-zinc-100">{item.title}</p>
                        <span className={`text-[10px] font-black uppercase ${item.status === "failed" ? "text-red-300" : "text-emerald-300"}`}>{item.status}</span>
                      </div>
                      {item.detail ? <p className="mt-1 line-clamp-2 text-[11px] text-zinc-500">{item.detail}</p> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="hidden items-center gap-2 rounded-xl border border-zinc-800 px-2.5 py-1.5 md:flex">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-800"><UserRound className="h-3.5 w-3.5" /></span>
              <span className="max-w-36 truncate text-xs font-bold text-zinc-300">{user.name || user.email || "Administrator"}</span>
              <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[9px] font-black uppercase text-purple-200">{role}</span>
            </div>
          </div>
        </header>

        <main className="min-h-[calc(100dvh-7.5rem)] px-4 py-5 sm:px-6">
          <div className="mx-auto w-full max-w-[104rem]">
            <div className="mb-5 flex flex-col gap-4 border-b border-zinc-800 pb-5 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2 text-xs font-bold text-zinc-600">
                  <Link href="/admin/overview" className="hover:text-zinc-300">Admin Console</Link>
                  <span>/</span>
                  {"parentLabel" in page && page.parentLabel ? (
                    <>
                      <Link href={page.href} className="hover:text-zinc-300">{page.parentLabel}</Link>
                      <span>/</span>
                    </>
                  ) : null}
                  <span className="text-zinc-400">{page.label}</span>
                </div>
                <h1 className="mt-2 text-2xl font-black tracking-tight text-white sm:text-3xl">{page.label}</h1>
                <p className="mt-1 text-sm text-zinc-500">{page.description}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!pageWritable ? <span className="rounded-full border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-black text-zinc-400">Read-only for {role}</span> : null}
                <button type="button" onClick={() => setAutoRefresh((value) => !value)} className={`rounded-xl border px-3 py-2 text-xs font-bold ${autoRefresh ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-zinc-800 text-zinc-400"}`} aria-pressed={autoRefresh}>
                  {autoRefresh ? "Auto 60s" : "Manual refresh"}
                </button>
                <button type="button" onClick={() => refresh("manual")} className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-black text-white hover:bg-zinc-800">
                  <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
                </button>
                <span className="text-[11px] text-zinc-600">Updated {lastUpdated.toISOString().slice(11, 19)} UTC</span>
              </div>
            </div>
            {children}
          </div>
        </main>

        <footer className="border-t border-zinc-800 bg-[#08090c] px-4 py-3 text-[11px] text-zinc-500 sm:px-6">
          <div className="mx-auto flex max-w-[104rem] flex-wrap items-center gap-x-5 gap-y-2">
            <span className="font-black uppercase tracking-[0.14em] text-zinc-400">{environment}</span>
            <span className={delayedJobCount && delayedJobCount > 0 ? "text-amber-300" : "text-emerald-300"}>Job health: {delayedJobCount === null ? "Unknown" : delayedJobCount > 0 ? `${delayedJobCount} delayed` : "Healthy"}</span>
            <span className={statusTone(apiStatus)}>API/DB: {apiStatus}</span>
            <span>Version {version}</span>
            <span className="ml-auto">Role: {role}</span>
          </div>
        </footer>
      </div>

      {commandOpen ? (
        <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/75 px-4 pt-[8vh] backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Admin command palette">
          <button type="button" className="absolute inset-0" onClick={() => setCommandOpen(false)} aria-label="Close command palette" />
          <div className="relative z-10 max-h-[80vh] w-full max-w-2xl overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl">
            <div className="flex items-center gap-3 border-b border-zinc-800 px-4">
              <Command className="h-5 w-5 text-blue-300" />
              <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search records or type a page name..." className="h-14 min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-zinc-600" />
              {searching ? <Loader2 className="h-4 w-4 animate-spin text-zinc-500" /> : null}
              <button type="button" onClick={() => setCommandOpen(false)} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-zinc-900" aria-label="Close"><X className="h-4 w-4" /></button>
            </div>
            <div className="max-h-[calc(80vh-3.5rem)] overflow-y-auto p-3">
              {query.trim().length < 2 ? (
                <>
                  <p className="px-2 pb-2 text-[10px] font-black uppercase tracking-[0.16em] text-zinc-600">Recent</p>
                  {recentItems.map(({ path, item }) => (
                    <button key={path} type="button" onClick={() => navigate(path)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-zinc-900">
                      <FileClock className="h-4 w-4 text-zinc-500" /><span><span className="block text-sm font-bold text-zinc-200">{item.label}</span><span className="block text-xs text-zinc-600">{path}</span></span>
                    </button>
                  ))}
                  <p className="mt-3 px-2 pb-2 text-[10px] font-black uppercase tracking-[0.16em] text-zinc-600">Pages</p>
                  {ALL_ITEMS.slice(0, 9).map((item) => (
                    <button key={item.href} type="button" onClick={() => navigate(item.href)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-zinc-900">
                      <item.icon className="h-4 w-4 text-blue-300" /><span><span className="block text-sm font-bold text-zinc-200">{item.label}</span><span className="block text-xs text-zinc-600">{item.description}</span></span>
                    </button>
                  ))}
                </>
              ) : (
                <>
                  {ALL_ITEMS.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(query.toLowerCase())).map((item) => (
                    <button key={item.href} type="button" onClick={() => navigate(item.href)} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-zinc-900"><item.icon className="h-4 w-4 text-blue-300" /><span className="text-sm font-bold text-zinc-200">{item.label}</span></button>
                  ))}
                  {searchResults.map((result) => (
                    <button key={`${result.type}-${result.id}`} type="button" onClick={() => navigate(result.href)} className="mt-1 flex w-full items-center justify-between gap-3 rounded-xl border border-zinc-800 px-3 py-2.5 text-left hover:bg-zinc-900">
                      <span className="min-w-0"><span className="block truncate text-sm font-bold text-zinc-200">{result.title}</span><span className="block truncate text-xs text-zinc-600">{result.type} · {result.detail}</span></span><ChevronDown className="h-4 w-4 -rotate-90 text-zinc-600" />
                    </button>
                  ))}
                  {!searching && searchResults.length === 0 ? <p className="p-5 text-center text-sm text-zinc-600">No matching records.</p> : null}
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
