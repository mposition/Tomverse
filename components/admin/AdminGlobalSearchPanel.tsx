"use client";

import Link from "next/link";
import { useState } from "react";
import { Loader2, Search } from "lucide-react";
import { dispatchAppToast } from "@/lib/appToast";

type SearchResult = {
  type: string;
  id: string;
  title: string;
  detail: string;
  href: string;
  createdAt: string | null;
};

const dateLabel = (value: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().replace("T", " ").slice(0, 16);
};

export function AdminGlobalSearchPanel() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const runSearch = async () => {
    const normalized = query.trim();
    if (normalized.length < 2) {
      setResults([]);
      return;
    }
    setIsSearching(true);
    try {
      const response = await fetch(
        `/api/admin/search?q=${encodeURIComponent(normalized)}`,
        { cache: "no-store" }
      );
      const data = (await response.json().catch(() => null)) as
        | { results?: SearchResult[]; error?: string }
        | null;
      if (!response.ok || !data?.results) {
        throw new Error(data?.error || "Admin search failed.");
      }
      setResults(data.results);
    } catch (error) {
      dispatchAppToast(
        error instanceof Error ? error.message : "Admin search failed.",
        "error"
      );
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/70 p-5">
      <div>
        <p className="text-xs font-black uppercase tracking-[0.18em] text-blue-300">
          Global search
        </p>
        <h2 className="mt-2 text-2xl font-black text-white">Find customers, tickets, refunds, and audit events</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
          Search across the operational records operators use most often.
        </p>
      </div>

      <form
        className="mt-5 grid gap-3 md:grid-cols-[1fr_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          runSearch();
        }}
      >
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search email, Stripe ID, trace ID, refund, audit action..."
            className="h-11 w-full rounded-xl border border-zinc-800 bg-zinc-950 pl-10 pr-3 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
          />
        </label>
        <button
          type="submit"
          disabled={isSearching}
          className="inline-flex h-11 cursor-pointer items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-black text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Search
        </button>
      </form>

      <div className="mt-5 grid gap-2">
        {results.length === 0 ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 text-sm text-zinc-400">
            Enter at least two characters to search Admin records.
          </div>
        ) : (
          results.map((result) => (
            <Link
              key={`${result.type}-${result.id}`}
              href={result.href}
              className="flex min-w-0 cursor-pointer items-center justify-between gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/70 px-4 py-3 transition hover:border-blue-500/40 hover:bg-zinc-900"
            >
              <span className="min-w-0">
                <span className="inline-flex rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-[11px] font-black uppercase tracking-[0.12em] text-blue-200">
                  {result.type}
                </span>
                <span className="mt-2 block truncate text-sm font-black text-white">
                  {result.title}
                </span>
                <span className="mt-1 block truncate text-xs text-zinc-500">
                  {result.detail}
                </span>
              </span>
              <span className="shrink-0 text-xs text-zinc-500">{dateLabel(result.createdAt)}</span>
            </Link>
          ))
        )}
      </div>
    </section>
  );
}
