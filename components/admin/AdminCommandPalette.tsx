"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Command, FileClock, Loader2, Pin, Search, X } from "lucide-react";
import {
  ADMIN_NAV_GROUPS,
  ADMIN_SEARCHABLE_PAGES,
  matchAdminPages,
  resolveAdminPageMeta,
  type AdminSearchablePage,
} from "@/lib/adminNavigation";
import { adminNavIcon } from "@/components/admin/adminNavigationIcons";
import { useAdminConsolePreferences } from "@/components/admin/AdminConsolePreferences";

type SearchResult = {
  type: string;
  id: string;
  title: string;
  detail: string;
  href: string;
  createdAt: string | null;
};

type Option = {
  key: string;
  href: string;
  label: string;
  detail: string;
  kind: "page" | "record" | "action";
};

type Section = {
  id: string;
  heading: string;
  /**
   * Shown above the section's options when it found nothing.
   *
   * Kept separate from `options.length`: the Records section always offers
   * "View all results", so a length check would report that section as
   * populated when it matched nothing.
   */
  emptyMessage?: string;
  options: Option[];
};

const MINIMUM_QUERY_LENGTH = 2;

const pageOption = (page: AdminSearchablePage, prefix: string): Option => ({
  key: `${prefix}:${page.href}`,
  href: page.href,
  label: page.label,
  detail: page.description,
  kind: "page",
});

/**
 * Mounted only while it is open, so closing it discards its state.
 *
 * That is what lets the query, the fetched records and the keyboard cursor
 * reset without an effect that writes state on every `open` transition.
 */
export function AdminCommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { pinned, recent } = useAdminConsolePreferences();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  /**
   * The keyboard cursor, tagged with the result set it belongs to.
   *
   * Stored together rather than reset from an effect: when the query or the
   * record results change, the tag stops matching and the cursor reads as 0
   * during the same render, with no second pass.
   */
  const [selection, setSelection] = useState({ key: "", index: 0 });
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const normalized = query.trim();
  const isSearch = normalized.length >= MINIMUM_QUERY_LENGTH;
  const selectionKey = `${normalized}|${results.length}`;
  const activeIndex = selection.key === selectionKey ? selection.index : 0;
  const setActiveIndex = (next: number | ((current: number) => number)) =>
    setSelection((current) => {
      const base = current.key === selectionKey ? current.index : 0;
      return {
        key: selectionKey,
        index: typeof next === "function" ? next(base) : next,
      };
    });

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!isSearch) {
      queueMicrotask(() => {
        setResults([]);
        setSearching(false);
      });
      return;
    }
    queueMicrotask(() => setSearching(true));
    searchTimer.current = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/admin/search?q=${encodeURIComponent(normalized)}&take=6`,
          { cache: "no-store" }
        );
        const data = (await response.json().catch(() => null)) as
          | { results?: SearchResult[] }
          | null;
        setResults(response.ok ? data?.results || [] : []);
      } finally {
        setSearching(false);
      }
    }, 220);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [isSearch, normalized]);

  const sections = useMemo<Section[]>(() => {
    if (isSearch) {
      const pages = matchAdminPages(normalized);
      return [
        {
          id: "pages",
          heading: `Pages (${pages.length})`,
          emptyMessage:
            pages.length === 0 ? "No console page matches that name." : undefined,
          options: pages.map((page) => pageOption(page, "match")),
        },
        {
          id: "records",
          heading: `Records (${results.length})`,
          // Worded as a scope statement, not as a verdict on the whole search:
          // a query that matched three pages and no customers is a successful
          // search, and the previous "No matching records." sat under those
          // page results reading like a total failure.
          emptyMessage:
            results.length > 0
              ? undefined
              : searching
                ? "Searching customers, refunds, traces, and audit events..."
                : "No customer, refund, trace, or audit record matches. Page results above are unaffected.",
          options: [
            ...results.map((result) => ({
              key: `record:${result.type}:${result.id}`,
              href: result.href,
              label: result.title,
              detail: `${result.type} · ${result.detail}`,
              kind: "record" as const,
            })),
            {
              key: "action:view-all",
              href: `/admin/search?q=${encodeURIComponent(normalized)}`,
              label: "View all results",
              detail: "Open the global search workspace for this query",
              kind: "action" as const,
            },
          ],
        },
      ];
    }

    const pinnedPages = pinned
      .map((href) => ADMIN_SEARCHABLE_PAGES.find((page) => page.href === href))
      .filter((page): page is AdminSearchablePage => Boolean(page));
    const recentOptions = recent
      .map((path) => ({ path, meta: resolveAdminPageMeta(path) }))
      // A recent route the table no longer describes is dropped rather than
      // shown under a borrowed title.
      .filter(({ meta }) => meta.isKnown)
      .map(({ path, meta }) => ({
        key: `recent:${path}`,
        href: path,
        label: meta.label,
        detail: path,
        kind: "page" as const,
      }));

    return [
      ...(pinnedPages.length > 0
        ? [
            {
              id: "pinned",
              heading: "Pinned",
              options: pinnedPages.map((page) => pageOption(page, "pinned")),
            },
          ]
        : []),
      ...(recentOptions.length > 0
        ? [{ id: "recent", heading: "Recent", options: recentOptions }]
        : []),
      // Every page, grouped exactly as the sidebar groups them. The palette
      // used to list `ALL_ITEMS.slice(0, 9)`, so seven of the console's pages
      // were unreachable from an empty palette and nothing said so.
      ...ADMIN_NAV_GROUPS.map((group) => ({
        id: `group:${group}`,
        heading: group,
        options: ADMIN_SEARCHABLE_PAGES.filter(
          (page) => page.group === group
        ).map((page) => pageOption(page, "all")),
      })),
      {
        id: "group:other",
        heading: "Other",
        options: ADMIN_SEARCHABLE_PAGES.filter((page) => page.group === null).map(
          (page) => pageOption(page, "all")
        ),
      },
    ].filter((section) => section.options.length > 0);
  }, [isSearch, normalized, pinned, recent, results, searching]);

  const options = useMemo(
    () => sections.flatMap((section) => section.options),
    [sections]
  );

  const navigate = useCallback(
    (href: string) => {
      onClose();
      router.push(href);
    },
    [onClose, router]
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (options.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % options.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + options.length) % options.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(options.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = options[activeIndex];
      if (option) navigate(option.href);
    }
  };

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>(
      '[data-active-option="true"]'
    );
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, sections]);

  const activeOptionId = options[activeIndex]
    ? `admin-palette-option-${activeIndex}`
    : undefined;
  // Keyboard position is the option's index in the flattened list, so each
  // rendered row resolves its own index rather than relying on a counter
  // mutated across sections during render.
  const indexOf = (key: string) => options.findIndex((option) => option.key === key);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/75 px-4 pt-[8vh] backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Admin command palette"
    >
      <button
        type="button"
        className="absolute inset-0"
        onClick={onClose}
        aria-label="Close command palette"
      />
      <div className="relative z-10 flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-700 bg-zinc-950 shadow-2xl">
        <div className="flex items-center gap-3 border-b border-zinc-800 px-4">
          <Command className="h-5 w-5 text-blue-300" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded
            aria-controls="admin-palette-results"
            aria-activedescendant={activeOptionId}
            aria-label="Search records or type a page name"
            placeholder="Search records or type a page name..."
            className="h-14 min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-zinc-500"
          />
          {searching ? (
            <Loader2 className="h-4 w-4 animate-spin text-zinc-500" aria-hidden />
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-zinc-900"
            aria-label="Close"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div
          ref={listRef}
          id="admin-palette-results"
          role="listbox"
          aria-label="Command palette results"
          className="min-h-0 flex-1 overflow-y-auto p-3"
        >
          {sections.map((section) => (
            <section key={section.id} className="mb-3 last:mb-0">
              <h2 className="px-2 pb-1.5 text-xs font-bold uppercase tracking-[0.16em] text-zinc-400">
                {section.heading}
              </h2>
              {section.emptyMessage ? (
                <p className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5 text-xs leading-5 text-zinc-400">
                  {section.emptyMessage}
                </p>
              ) : null}
              {section.options.map((option) => {
                const index = indexOf(option.key);
                const active = index === activeIndex;
                const Icon =
                  option.kind === "record"
                    ? Search
                    : option.kind === "action"
                      ? ArrowRight
                      : section.id === "recent"
                        ? FileClock
                        : section.id === "pinned"
                          ? Pin
                          : adminNavIcon(
                              ADMIN_SEARCHABLE_PAGES.find(
                                (page) => page.href === option.href
                              )?.id || "overview"
                            );
                return (
                  <button
                    key={option.key}
                    id={`admin-palette-option-${index}`}
                    role="option"
                    aria-selected={active}
                    data-active-option={active ? "true" : undefined}
                    type="button"
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => navigate(option.href)}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                      active
                        ? "bg-blue-600/20 ring-2 ring-inset ring-blue-400"
                        : "hover:bg-zinc-900"
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-blue-300" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold text-zinc-100">
                        {option.label}
                      </span>
                      <span className="block truncate text-xs text-zinc-400">
                        {option.detail}
                      </span>
                    </span>
                  </button>
                );
              })}
            </section>
          ))}
        </div>

        <p className="border-t border-zinc-800 px-4 py-2 text-xs text-zinc-500">
          <kbd className="font-bold text-zinc-300">↑</kbd>{" "}
          <kbd className="font-bold text-zinc-300">↓</kbd> to move ·{" "}
          <kbd className="font-bold text-zinc-300">Enter</kbd> to open ·{" "}
          <kbd className="font-bold text-zinc-300">Esc</kbd> to close
        </p>
      </div>
    </div>
  );
}
