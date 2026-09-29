import Link from "next/link";
import type { AdminRole } from "@/lib/adminAuthCore";
import {
  adminVisibleTabs,
  findAdminNavItem,
  type AdminNavTab,
} from "@/lib/adminNavigation";
import {
  adminNavigationBadge,
  type AdminNavigationCounts,
} from "@/lib/adminNavigationBadges";
import { adminMessagesFor } from "@/lib/adminLocale";
import { getAdminLocale } from "@/lib/adminLocaleServer";
import { adminShellMessages } from "@/lib/adminMessages/shell";
import {
  localizeAdminNavItem,
  localizeAdminTabs,
} from "@/lib/adminNavigationLocale";

/** A short state beside a tab's label, e.g. whether its writes are switched on. */
export type AdminPageTabChip = {
  label: string;
  /** Drawn in the attention colour: writes are open, rather than closed. */
  attention?: boolean;
};

type Props = {
  /** The page's own path, e.g. `/admin/providers`. */
  basePath: string;
  tabs: readonly AdminNavTab[];
  activeTabId: string;
  /**
   * Accessible name for the tab strip, e.g. "Providers sections". English; in
   * another console locale the name is derived from the localised page label.
   */
  label: string;
  /**
   * The rest of the page's query string, carried onto every tab link so a
   * filter or a deep-linked record survives switching section.
   */
  query?: Record<string, string | string[] | undefined>;
  /**
   * The viewer's role. A tab declaring `viewRoles` is shown only to those
   * roles, and to nobody when this is absent -- the strip must not offer a
   * section the page would answer 404 for.
   */
  role?: AdminRole | null;
  /**
   * Counts for the tabs that declare a `badge`, derived exactly as the
   * sidebar derives an entry's. An unknown count renders nothing, not zero.
   */
  counts?: AdminNavigationCounts;
  /** Chips keyed by tab id. The caller reads the state; the strip draws it. */
  chips?: Readonly<Record<string, AdminPageTabChip | undefined>>;
};

/**
 * Section navigation for a consolidated Admin Console page.
 *
 * Links, not buttons, and the active section lives in `?tab=`: the section an
 * operator is looking at has to be in the URL for a deep link, a bookmark, a
 * back button or a pasted link in an incident channel to mean anything. It also
 * lets the page's server component load only the active section's data instead
 * of every section's.
 *
 * A server component on purpose -- there is no state to hold, and the query is
 * already resolved by the page above it. It reads the console locale from the
 * same request the layout did, so its labels cannot disagree with the shell's.
 */
export async function AdminPageTabs({
  basePath,
  tabs: sourceTabs,
  activeTabId,
  label: sourceLabel,
  query = {},
  role,
  counts,
  chips = {},
}: Props) {
  const locale = await getAdminLocale();
  const shell = adminMessagesFor(adminShellMessages, locale);
  const item = findAdminNavItem(basePath);
  const tabs = adminVisibleTabs(
    item ? localizeAdminTabs(item.id, sourceTabs, locale) : sourceTabs,
    role
  );
  const label =
    item && locale !== "en"
      ? shell.tabs.sections(localizeAdminNavItem(item, locale).label)
      : sourceLabel;
  const badgeFor = (tab: AdminNavTab) =>
    tab.badge && counts ? adminNavigationBadge(tab.badge, counts) : null;
  const hrefFor = (tabId: string) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (key === "tab") continue;
      const first = Array.isArray(value) ? value[0] : value;
      if (typeof first === "string" && first.length > 0) params.set(key, first);
    }
    params.set("tab", tabId);
    return `${basePath}?${params.toString()}`;
  };

  return (
    <nav aria-label={label} className="min-w-0">
      <ul className="flex min-w-0 flex-wrap gap-2">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          const chip = chips[tab.id];
          const badge = badgeFor(tab);
          // Zero draws nothing, as in the sidebar; so does an unknown count.
          const count = badge !== null && badge > 0 ? badge : null;
          return (
            <li key={tab.id} className="min-w-0">
              <Link
                href={hrefFor(tab.id)}
                aria-current={active ? "page" : undefined}
                // Named only when there is more than the label to say, and
                // then stated rather than concatenated from the contents, as
                // the sidebar does: "Assignment, 2 awaiting action", not
                // "Assignment2".
                aria-label={
                  chip || count !== null
                    ? `${tab.label}${chip ? `, ${chip.label}` : ""}${
                        count !== null ? shell.sidebar.awaitingAction(count) : ""
                      }`
                    : undefined
                }
                // `scroll={false}` keeps the operator's position when they
                // switch section on a long page; the heading above the strip
                // does not move, so scrolling to the top would lose their place
                // for no gain.
                scroll={false}
                className={`flex min-h-11 items-center gap-2 rounded-xl border px-4 py-2 text-sm font-bold transition ${
                  active
                    ? "border-blue-500/40 bg-blue-500/15 text-white"
                    : "border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:border-zinc-700 hover:text-white"
                }`}
              >
                <span className="truncate">{tab.label}</span>
                {chip ? (
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-bold ${
                      chip.attention
                        ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                        : "border-zinc-700 bg-zinc-950 text-zinc-300"
                    }`}
                  >
                    {chip.label}
                  </span>
                ) : null}
                {count !== null ? (
                  <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-bold tabular-nums text-amber-200">
                    {count}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 px-1 text-xs text-zinc-400">
        {tabs.find((tab) => tab.id === activeTabId)?.description}
      </p>
    </nav>
  );
}
