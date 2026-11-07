import Link from "next/link";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminUiMessages } from "@/lib/adminMessages/ui";

type Query = Record<string, string | string[] | undefined>;

/**
 * A second, lighter strip under a tab that still holds more than one of the
 * screens it replaced (`?tab=reports&view=competitors`). Links, like the tab
 * strip: the view an operator is looking at is in the URL.
 *
 * Temporary by design: when the tab's own screen is built the views go and the
 * page edits nothing in the route table.
 */
export async function AdminViewSwitch({
  basePath,
  tabId,
  views,
  activeId,
  label,
  query = {},
}: {
  basePath: string;
  tabId: string;
  views: readonly { id: string; label: string; chip?: string }[];
  activeId: string;
  /** Accessible name; defaults to the console's "Views". */
  label?: string;
  query?: Query;
}) {
  const m = await getAdminMessages(adminUiMessages);
  const hrefFor = (viewId: string) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (key === "tab" || key === "view") continue;
      const first = Array.isArray(value) ? value[0] : value;
      if (typeof first === "string" && first.length > 0) params.set(key, first);
    }
    params.set("tab", tabId);
    params.set("view", viewId);
    return `${basePath}?${params.toString()}`;
  };
  return (
    <nav aria-label={label ?? m.views} className="min-w-0">
      <ul className="flex min-w-0 flex-wrap gap-1 border-b border-zinc-800">
        {views.map((view) => {
          const active = view.id === activeId;
          return (
            <li key={view.id} className="min-w-0">
              <Link
                href={hrefFor(view.id)}
                aria-current={active ? "page" : undefined}
                scroll={false}
                className={`-mb-px flex min-h-11 items-center border-b-2 px-3 py-2 text-sm transition ${
                  active
                    ? "border-blue-500 font-semibold text-white"
                    : "border-transparent font-medium text-zinc-400 hover:border-zinc-600 hover:text-zinc-100"
                }`}
              >
                <span className="truncate">{view.label}</span>
                {view.chip ? (
                  <span className="ml-2 shrink-0 rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-semibold tabular-nums text-blue-300">
                    {view.chip}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
