"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminDataTable, type AdminDataColumn } from "@/components/admin/ui/AdminDataTable";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { adminIntlLocale } from "@/lib/adminLocale";
import { adminCreditLedgerMessages } from "@/lib/adminMessages/creditLedger";
import {
  ledgerTypeTone,
  ledgerTypesPresent,
  type AdminCreditLedgerRow,
} from "@/lib/adminCreditLedgerStats";
import { formatAestDateTime } from "@/lib/adminUiCore";

const dateLabel = (value: string) => formatAestDateTime(value) ?? "-";

/**
 * The ledger table with its type chips and customer search.
 *
 * Read-only, and filtering happens in the browser over the rows the server
 * already read: it narrows what is on screen, it does not query for more.
 */
export function AdminCreditLedgerTable({ rows }: { rows: AdminCreditLedgerRow[] }) {
  const m = useAdminMessages(adminCreditLedgerMessages);
  const { locale } = useAdminLocale();
  const intlLocale = adminIntlLocale(locale);
  const [type, setType] = useState<string>("all");
  const [query, setQuery] = useState("");
  const types = useMemo(() => ledgerTypesPresent(rows), [rows]);
  const typeLabels = m.types as Record<string, string>;
  const typeLabel = (value: string) => typeLabels[value] ?? value;

  const needle = query.trim().toLowerCase();
  const visible = rows.filter(
    (row) =>
      (type === "all" || row.type === type) &&
      (needle === "" ||
        (row.userEmail ?? "").toLowerCase().includes(needle) ||
        row.userId.toLowerCase().includes(needle))
  );

  const columns: AdminDataColumn<AdminCreditLedgerRow>[] = [
    {
      key: "created",
      header: m.columns.created,
      render: (row) => <span className="whitespace-nowrap text-xs text-zinc-400">{dateLabel(row.createdAt)}</span>,
    },
    {
      key: "customer",
      header: m.columns.customer,
      render: (row) => (
        <Link
          href={`/admin/users/${encodeURIComponent(row.userId)}`}
          className="block max-w-64 truncate font-bold text-blue-300 hover:text-blue-200"
        >
          {row.userEmail || row.userId}
        </Link>
      ),
    },
    {
      key: "type",
      header: m.columns.type,
      render: (row) => <AdminStatusChip tone={ledgerTypeTone(row.type)}>{typeLabel(row.type)}</AdminStatusChip>,
    },
    {
      key: "detail",
      header: m.columns.detail,
      hideOnCard: true,
      render: (row) => {
        const cost = row.fundedCostMicroUsdDelta / 1_000_000;
        return (
          <div className="min-w-0 text-xs text-zinc-400">
            {row.reservationId ? (
              <p className="truncate font-mono" title={row.reservationId}>
                {m.detail.reservation(row.reservationId.slice(0, 8))}
              </p>
            ) : null}
            {cost !== 0 ? <p>{m.detail.fundedCost(`${cost < 0 ? "-" : ""}$${Math.abs(cost).toFixed(4)}`)}</p> : null}
            {!row.reservationId && cost === 0 ? "-" : null}
          </div>
        );
      },
    },
    {
      key: "change",
      header: m.columns.change,
      align: "right",
      render: (row) => (
        <span className={`font-bold tabular-nums ${row.creditsDelta >= 0 ? "text-emerald-300" : "text-amber-300"}`}>
          {row.creditsDelta >= 0 ? "+" : ""}
          {row.creditsDelta.toLocaleString(intlLocale)}
        </span>
      ),
    },
    {
      key: "balance",
      header: m.columns.balance,
      align: "right",
      render: (row) => <span className="font-bold tabular-nums text-white">{row.balanceAfterCredits.toLocaleString(intlLocale)}</span>,
    },
  ];

  const chip = (active: boolean) =>
    `inline-flex min-h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-bold transition ${
      active ? "bg-white text-zinc-950" : "border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
    }`;

  return (
    <AdminDataTable
      caption={m.table.caption}
      rows={visible}
      rowKey={(row) => row.id}
      columns={columns}
      cardTitle={(row) => (
        <Link href={`/admin/users/${encodeURIComponent(row.userId)}`} className="text-blue-300">
          {row.userEmail || row.userId}
        </Link>
      )}
      cardMeta={(row) => (
        <span className="flex flex-wrap items-center gap-2">
          <AdminStatusChip tone={ledgerTypeTone(row.type)}>{typeLabel(row.type)}</AdminStatusChip>
          <span>{dateLabel(row.createdAt)}</span>
        </span>
      )}
      cardAside={(row) => (
        <span className={`font-bold tabular-nums ${row.creditsDelta >= 0 ? "text-emerald-300" : "text-amber-300"}`}>
          {row.creditsDelta >= 0 ? "+" : ""}
          {row.creditsDelta.toLocaleString(intlLocale)}
        </span>
      )}
      toolbar={
        <>
          <label className="relative min-w-48 flex-1 sm:max-w-xs">
            <span className="sr-only">{m.filters.searchLabel}</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={m.filters.searchPlaceholder}
              className="min-h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950 pl-9 pr-3 text-sm text-white outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10"
            />
          </label>
          <div role="group" aria-label={m.filters.label} className="flex flex-wrap gap-2">
            <button type="button" aria-pressed={type === "all"} onClick={() => setType("all")} className={chip(type === "all")}>
              {m.filters.all}
            </button>
            {types.map((entry) => (
              <button
                key={entry.type}
                type="button"
                aria-pressed={type === entry.type}
                onClick={() => setType(entry.type)}
                className={chip(type === entry.type)}
              >
                {typeLabel(entry.type)}
              </button>
            ))}
          </div>
        </>
      }
      emptyState={
        rows.length === 0 ? (
          <AdminStateBlock kind="empty" title={m.empty.title} detail={m.empty.detail} />
        ) : (
          <AdminStateBlock kind="empty" title={m.filters.noMatch.title} detail={m.filters.noMatch.detail} />
        )
      }
    />
  );
}
