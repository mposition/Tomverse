"use client";

import Link from "next/link";
import { Pin, PinOff } from "lucide-react";
import {
  localizedAdminSearchablePages,
  type LocalizedAdminSearchablePage,
} from "@/lib/adminNavigationLocale";
import { adminQuickAccessMessages } from "@/lib/adminMessages/quickAccess";
import { adminNavIcon } from "@/components/admin/adminNavigationIcons";
import { useAdminConsolePreferences } from "@/components/admin/AdminConsolePreferences";
import {
  useAdminLocale,
  useAdminMessages,
} from "@/components/admin/AdminLocaleProvider";

/**
 * The pinned-pages list, shown on Overview and shared with the sidebar and the
 * command palette.
 *
 * Replaces "Saved views", whose "Set default" button wrote a preference nothing
 * read: `/admin` still opened Overview, the sidebar still listed the same
 * entries in the same order, and the only visible effect was the star filling
 * in. Pinning changes two other surfaces immediately, so the control's claim
 * and its effect match.
 */
export function AdminQuickAccessPanel() {
  const { pinned, togglePin, ready, pinLimit } = useAdminConsolePreferences();
  const { locale } = useAdminLocale();
  const m = useAdminMessages(adminQuickAccessMessages);
  const searchablePages = localizedAdminSearchablePages(locale);
  const pages = pinned
    .map((href) => searchablePages.find((page) => page.href === href))
    .filter((page): page is LocalizedAdminSearchablePage => Boolean(page));

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xl font-black text-white">{m.title}</h2>
        <p className="text-xs text-zinc-400">
          {m.pinnedCount(pinned.length, pinLimit)}
        </p>
      </div>
      <p className="mt-1 text-sm leading-6 text-zinc-400">{m.description}</p>
      {!ready ? null : pages.length === 0 ? (
        <p className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-300">
          {m.emptyBefore}
          <strong>{m.emptyAction}</strong>
          {m.emptyAfter}
        </p>
      ) : (
        <ul className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {pages.map((page) => {
            const Icon = adminNavIcon(page.id);
            return (
              <li
                key={page.href}
                className="flex items-stretch gap-1 rounded-2xl border border-zinc-800 bg-zinc-900/70"
              >
                <Link
                  href={page.href}
                  className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-2xl px-3 py-2 text-sm font-bold text-white hover:text-blue-200"
                >
                  <Icon className="h-4 w-4 shrink-0 text-blue-300" aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate">{page.label}</span>
                    <span className="block truncate text-xs font-medium text-zinc-400">
                      {page.description}
                    </span>
                  </span>
                </Link>
                <button
                  type="button"
                  onClick={() => togglePin(page.href)}
                  aria-label={m.unpin(page.label)}
                  className="flex w-10 shrink-0 items-center justify-center rounded-2xl text-zinc-400 transition hover:text-white"
                >
                  <Pin className="h-4 w-4 fill-current" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {pinned.length >= pinLimit ? (
        <p className="mt-3 inline-flex items-center gap-2 text-xs text-amber-200">
          <PinOff className="h-3.5 w-3.5" aria-hidden />
          {m.full}
        </p>
      ) : null}
    </section>
  );
}
