import Link from "next/link";
import { findAdminNavItem, type AdminNavTab } from "@/lib/adminNavigation";
import { adminMessagesFor } from "@/lib/adminLocale";
import { getAdminLocale } from "@/lib/adminLocaleServer";
import { adminShellMessages } from "@/lib/adminMessages/shell";
import {
  localizeAdminNavItem,
  localizeAdminTabs,
} from "@/lib/adminNavigationLocale";

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
}: Props) {
  const locale = await getAdminLocale();
  const item = findAdminNavItem(basePath);
  const tabs = item ? localizeAdminTabs(item.id, sourceTabs, locale) : sourceTabs;
  const label =
    item && locale !== "en"
      ? adminMessagesFor(adminShellMessages, locale).tabs.sections(
          localizeAdminNavItem(item, locale).label
        )
      : sourceLabel;
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
          return (
            <li key={tab.id} className="min-w-0">
              <Link
                href={hrefFor(tab.id)}
                aria-current={active ? "page" : undefined}
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
