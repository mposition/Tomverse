"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ExternalLink, Pin, PinOff } from "lucide-react";
import {
  ADMIN_NAV_ITEMS_BY_GROUP,
  ADMIN_NAVIGATION,
  type AdminNavGroup,
  type AdminNavItem,
  adminItemIsWritable,
  findAdminNavItem,
} from "@/lib/adminNavigation";
import {
  adminNavigationBadge,
  type AdminNavigationCounts,
} from "@/lib/adminNavigationBadges";
import { adminNavIcon } from "@/components/admin/adminNavigationIcons";
import { useAdminConsolePreferences } from "@/components/admin/AdminConsolePreferences";
import type { AdminRole } from "@/lib/adminAuthCore";

const COLLAPSED_STORAGE_KEY = "tomverse-admin-collapsed-groups";

type Props = {
  pathname: string;
  role: AdminRole;
  counts: AdminNavigationCounts;
  /** The drawer renders each entry's description; the desktop rail does not. */
  variant: "rail" | "drawer";
  onNavigate?: () => void;
  /** Bumped by the shell each time the drawer opens, to re-run scrollIntoView. */
  revealToken?: number;
};

const readCollapsed = (): AdminNavGroup[] => {
  try {
    const stored = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as unknown;
    return Array.isArray(parsed)
      ? (parsed.filter((value) => typeof value === "string") as AdminNavGroup[])
      : [];
  } catch {
    return [];
  }
};

export function AdminSidebar({
  pathname,
  role,
  counts,
  variant,
  onNavigate,
  revealToken = 0,
}: Props) {
  const { pinned, isPinned, togglePin, pinLimit } = useAdminConsolePreferences();
  const [collapsed, setCollapsed] = useState<AdminNavGroup[]>([]);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const activeItem = findAdminNavItem(pathname);
  const activeGroup = activeItem?.group || null;

  useEffect(() => {
    // Read after the commit: the server cannot know this value, so reading it
    // during render would make the two renders disagree.
    queueMicrotask(() => setCollapsed(readCollapsed()));
  }, []);

  const toggleGroup = useCallback((group: AdminNavGroup) => {
    setCollapsed((current) => {
      const next = current.includes(group)
        ? current.filter((item) => item !== group)
        : [...current, group];
      try {
        window.localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Persistence is best-effort; the session-local state still applies.
      }
      return next;
    });
  }, []);

  /**
   * The group holding the current route is always open.
   *
   * Applied at render rather than by mutating stored state: collapsing a group
   * and then navigating into it should reveal the page you are on, without
   * silently rewriting the preference you set for every other visit.
   */
  const isOpen = (group: AdminNavGroup) =>
    group === activeGroup || !collapsed.includes(group);

  const pinnedItems = useMemo(
    () =>
      pinned
        .map((href) => ADMIN_NAVIGATION.find((item) => item.href === href))
        .filter((item): item is AdminNavItem => Boolean(item)),
    [pinned]
  );

  /**
   * Brings the current entry into view whenever the rail mounts or the drawer
   * opens.
   *
   * With seventeen entries in six groups the active one is regularly below the
   * fold on a 720px-tall viewport, and an operator who opens the drawer to see
   * where they are should not have to scroll to find out.
   */
  useEffect(() => {
    // Deferred to the next frame. The drawer is mounted and measured in the
    // same commit it becomes visible in, so an effect body that measures
    // immediately can read a scroll container that has no height yet and
    // scroll nothing. After a paint the geometry is real.
    const frame = requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const current = scroller.querySelector<HTMLElement>('a[aria-current="page"]');
      if (!current) return;
      const scrollerBox = scroller.getBoundingClientRect();
      const currentBox = current.getBoundingClientRect();
      if (
        currentBox.top >= scrollerBox.top &&
        currentBox.bottom <= scrollerBox.bottom
      ) {
        return;
      }
      current.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname, revealToken, collapsed]);

  const renderItem = (item: AdminNavItem, keyPrefix: string) => {
    const Icon = adminNavIcon(item.id);
    const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
    const writable = adminItemIsWritable(role, item);
    const badge = item.badge ? adminNavigationBadge(item.badge, counts) : null;
    const pinnedNow = isPinned(item.href);
    const atLimit = !pinnedNow && pinned.length >= pinLimit;
    return (
      <div
        key={`${keyPrefix}-${item.href}`}
        className={`group flex items-stretch gap-1 rounded-xl ${
          active ? "bg-blue-600" : "hover:bg-zinc-900"
        }`}
      >
        <Link
          href={item.href}
          onClick={onNavigate}
          aria-current={active ? "page" : undefined}
          // The name is stated rather than composed from the contents: the row
          // also carries a description line, a count badge and a read-only
          // marker, and letting all four concatenate would announce a
          // paragraph where a link name belongs. What matters for the operator
          // -- the label, whether anything is waiting, whether they can write
          // here -- is spelled out instead.
          aria-label={`${item.label}${
            badge !== null && badge > 0 ? `, ${badge} awaiting action` : ""
          }${writable ? "" : ", read-only"}`}
          className={`flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2 text-sm font-bold transition ${
            active ? "text-white" : "text-zinc-300 group-hover:text-white"
          }`}
          // Desktop keeps the hover hint; the drawer renders the same sentence
          // as visible text below, because a `title` is unreachable on touch.
          title={variant === "rail" ? item.description : undefined}
        >
          <Icon className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{item.label}</span>
            {variant === "drawer" ? (
              <span
                className={`mt-0.5 block truncate text-xs font-medium ${
                  active ? "text-blue-100" : "text-zinc-500"
                }`}
              >
                {item.description}
              </span>
            ) : null}
          </span>
          {badge !== null && badge > 0 ? (
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold tabular-nums ${
                active
                  ? "bg-white/20 text-white"
                  : "bg-amber-500/15 text-amber-200"
              }`}
            >
              {badge}
            </span>
          ) : null}
          {!writable ? (
            <span
              className={`shrink-0 text-xs font-bold uppercase tracking-wide ${
                active ? "text-blue-100" : "text-zinc-500"
              }`}
            >
              Read
            </span>
          ) : null}
        </Link>
        <button
          type="button"
          onClick={() => togglePin(item.href)}
          disabled={atLimit}
          aria-pressed={pinnedNow}
          aria-label={
            pinnedNow
              ? `Unpin ${item.label} from quick access`
              : atLimit
                ? `Quick access is full; unpin a page before pinning ${item.label}`
                : `Pin ${item.label} to quick access`
          }
          className={`flex w-9 shrink-0 items-center justify-center rounded-xl transition disabled:cursor-not-allowed disabled:opacity-40 ${
            pinnedNow
              ? "text-blue-200"
              : "text-zinc-600 hover:text-zinc-200 focus-visible:text-zinc-200"
          }`}
        >
          {pinnedNow ? (
            <Pin className="h-3.5 w-3.5 fill-current" aria-hidden />
          ) : (
            <PinOff className="h-3.5 w-3.5" aria-hidden />
          )}
        </button>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#08090c]">
      <div className="border-b border-zinc-800 px-4 py-4">
        <Link
          href="/admin/overview"
          className="flex items-center gap-3"
          onClick={onNavigate}
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 text-sm font-bold text-white">
            T
          </span>
          <span>
            <span className="block text-sm font-bold text-white">Tomverse</span>
            <span className="block text-xs font-bold text-blue-300">
              Admin Console
            </span>
          </span>
        </Link>
      </div>

      {/*
        One scroll owner for both regions. Quick access and the grouped
        navigation are separate landmarks -- the console's navigation contract
        is "exactly the route table lives in `Admin console navigation`", and a
        pinned duplicate inside it would break that for anything counting links.
      */}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {pinnedItems.length > 0 ? (
          <nav aria-label="Quick access" className="mb-5">
            <p className="mb-1.5 px-3 text-xs font-bold uppercase tracking-[0.16em] text-zinc-400">
              Quick access
            </p>
            <div className="grid gap-0.5">
              {pinnedItems.map((item) => renderItem(item, "pinned"))}
            </div>
          </nav>
        ) : null}

        <nav aria-label="Admin console navigation">
          {ADMIN_NAV_ITEMS_BY_GROUP.map((group) => {
            const open = isOpen(group.label);
            const panelId = `admin-nav-group-${group.label
              .toLowerCase()
              .replace(/\s+/g, "-")}`;
            const groupBadge = group.items.reduce<number | null>((total, item) => {
              const value = item.badge
                ? adminNavigationBadge(item.badge, counts)
                : null;
              if (value === null) return total;
              return (total || 0) + value;
            }, null);
            return (
              <div key={group.label} className="mb-4">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.label)}
                  aria-expanded={open}
                  aria-controls={panelId}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-xs font-bold uppercase tracking-[0.16em] text-zinc-400 transition hover:bg-zinc-900 hover:text-zinc-200"
                >
                  <ChevronDown
                    className={`h-3.5 w-3.5 shrink-0 transition-transform ${
                      open ? "" : "-rotate-90"
                    }`}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate">{group.label}</span>
                  {!open && groupBadge && groupBadge > 0 ? (
                    <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-bold tabular-nums text-amber-200">
                      {groupBadge}
                    </span>
                  ) : null}
                </button>
                <div id={panelId} hidden={!open} className="mt-1 grid gap-0.5">
                  {group.items.map((item) => renderItem(item, "group"))}
                </div>
              </div>
            );
          })}
        </nav>
      </div>

      <div className="border-t border-zinc-800 p-3">
        <Link
          href="/chat"
          className="flex items-center justify-center gap-2 rounded-xl border border-zinc-800 px-3 py-2 text-xs font-bold text-zinc-300 hover:bg-zinc-900"
        >
          Open Tomverse <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
    </div>
  );
}
