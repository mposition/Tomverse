import { KeyRound, LifeBuoy, ShieldCheck } from "lucide-react";
import type { ConfiguredAdminAccess } from "@/lib/adminAuth";
import { adminAccessMessages } from "@/lib/adminMessages/adminAccess";
import { getAdminMessages } from "@/lib/adminLocaleServer";

type AccessLevel = "full" | "read" | "write" | "no" | "allowed";

const roleRows: Array<[string, AccessLevel, AccessLevel, AccessLevel, AccessLevel, AccessLevel]> = [
  ["owner", "full", "full", "full", "full", "allowed"],
  ["billing", "read", "write", "read", "read", "no"],
  ["ops", "read", "read", "write", "read", "no"],
  ["support", "read", "no", "read", "write", "no"],
  ["readonly", "read", "read", "read", "read", "no"],
];

const dateLabel = (value: string | null | undefined, never: string) =>
  value ? new Date(value).toISOString().replace("T", " ").slice(0, 16) : never;

export async function AdminAccessPanel({ access }: { access: ConfiguredAdminAccess[] }) {
  const m = await getAdminMessages(adminAccessMessages);
  return (
    <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
      <section className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
          <KeyRound className="h-4 w-4" /> {m.roleMatrix}
        </div>
        <h2 className="mt-2 text-xl font-black text-white">{m.title}</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-500">
          {m.description}
        </p>
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-sm">
            <thead className="text-[10px] uppercase tracking-[0.15em] text-zinc-600">
              <tr>{[m.columns.role, m.columns.users, m.columns.billing, m.columns.aiOps, m.columns.support, m.columns.destructive].map((label) => <th key={label} className="px-3 py-2">{label}</th>)}</tr>
            </thead>
            <tbody className="text-zinc-300">
              {roleRows.map(([role, ...levels]) => {
                const row = [role, ...levels.map((level) => m.level[level])];
                return (
                  <tr key={row[0]} className="border-t border-zinc-800">
                    {row.map((cell, index) => <td key={`${row[0]}-${index}`} className={`px-3 py-3 ${index === 0 ? "font-black text-white" : "font-bold"}`}>{cell}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-4 flex items-start gap-2 text-xs leading-5 text-zinc-600">
          <LifeBuoy className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {m.envNote}
        </p>
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-5">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-blue-300">
          <ShieldCheck className="h-4 w-4" /> {m.configuredAdministrators}
        </div>
        <div className="mt-4 grid gap-2">
          {access.length === 0 ? (
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200">{m.noAdministrators}</div>
          ) : access.map((entry) => (
            <article key={`${entry.identityType}:${entry.identity}`} className="flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-white">{entry.identity}</p>
                <p className="mt-1 text-xs text-zinc-500">
                  {entry.identityType} · {entry.expiresAt ? m.expires(dateLabel(entry.expiresAt, m.never)) : m.noExpiry}
                </p>
                <p className="mt-1 text-xs text-zinc-600">
                  {m.lastSeen(dateLabel(entry.lastLoginAt, m.never), dateLabel(entry.lastActivityAt, m.never))}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full ${entry.accessEnabled ? "bg-emerald-400" : "bg-red-400"}`} aria-label={entry.accessEnabled ? m.accessEnabled : m.accessDisabled} />
                <span className={`rounded-full border px-2.5 py-1 text-xs font-bold uppercase ${entry.accessEnabled ? "border-blue-500/30 bg-blue-500/10 text-blue-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`}>{entry.role}</span>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
