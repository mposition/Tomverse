import { formatAestDate, formatAestDateTime } from "@/lib/adminUiCore";
import { LifeBuoy } from "lucide-react";
import type { ConfiguredAdminAccess } from "@/lib/adminAuth";
import { adminAccessMessages } from "@/lib/adminMessages/adminAccess";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import type { AdminMessageShape } from "@/lib/adminLocale";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";

type AccessLevel = "full" | "read" | "write" | "no" | "allowed";
type AccessMessages = AdminMessageShape<(typeof adminAccessMessages)["en"]>;

const roleRows: Array<[string, AccessLevel, AccessLevel, AccessLevel, AccessLevel, AccessLevel]> = [
  ["owner", "full", "full", "full", "full", "allowed"],
  ["billing", "read", "write", "read", "read", "no"],
  ["ops", "read", "read", "write", "read", "no"],
  ["support", "read", "no", "read", "write", "no"],
  ["readonly", "read", "read", "read", "read", "no"],
];

/** The four areas of the matrix, in column order (the fifth is destructive work). */
const AREAS = ["users", "billing", "aiOps", "support"] as const;

/**
 * What a role may do, as one sentence read off the same matrix the table below
 * draws, so the card and the table cannot disagree.
 */
export function describeAdminRoleCapability(role: string, m: AccessMessages): string {
  const row = roleRows.find(([name]) => name === role);
  if (!row) return m.capability.none;
  const levels = row.slice(1, 5) as AccessLevel[];
  if (levels.every((level) => level === "full")) return m.capability.everything;
  const named = (wanted: AccessLevel[]) =>
    AREAS.filter((_, index) => wanted.includes(levels[index]))
      .map((area) => m.area[area])
      .join(", ");
  const writes = named(["full", "write"]);
  const reads = named(["read"]);
  if (writes && reads) return m.capability.writesAndReads(writes, reads);
  if (writes) return m.capability.writes(writes);
  if (reads) return m.capability.readsOnly(reads);
  return m.capability.none;
}

const dateLabel = (value: string | null | undefined, never: string) =>
  formatAestDateTime(value) ?? never;

/**
 * The administrators as cards, and the role table folded below them. Pure: the
 * list comes from the same read as before (`getConfiguredAdminAccessWithActivity`)
 * and nothing here changes who may enter or what a role may do.
 */
export function AdminAccessView({ access, m }: { access: ConfiguredAdminAccess[]; m: AccessMessages }) {
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <AdminTile title={m.title} description={m.description}>
        {access.length === 0 ? (
          <AdminStateBlock kind="error" title={m.noAdministrators} />
        ) : (
          <div className="grid gap-4 [&>*]:min-w-0 md:grid-cols-2 xl:grid-cols-3" data-testid="admin-access-cards">
            {access.map((entry) => {
              const expiryDate = formatAestDate(entry.expiresAt);
              return (
                <article
                  key={`${entry.identityType}:${entry.identity}`}
                  className="flex flex-col gap-3 rounded-2xl border border-zinc-800 bg-zinc-950/40 p-4"
                >
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-500/15 text-sm font-bold uppercase text-blue-300"
                    >
                      {entry.identity.trim().charAt(0) || "?"}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-white">{entry.identity}</p>
                      <p className="text-xs text-zinc-500">{m.card.identityType[entry.identityType]}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <AdminStatusChip tone={entry.role === "not-authorized" ? "bad" : "info"}>
                        {entry.role === "not-authorized" ? m.card.notAuthorized : entry.role}
                      </AdminStatusChip>
                      {entry.expired ? <AdminStatusChip tone="bad">{m.card.expired}</AdminStatusChip> : null}
                      {!entry.accessEnabled && !entry.expired ? (
                        <AdminStatusChip tone="bad">{m.accessDisabled}</AdminStatusChip>
                      ) : null}
                    </div>
                  </div>
                  <dl className="flex flex-col text-sm">
                    {[
                      [m.card.canDo, describeAdminRoleCapability(entry.role, m)],
                      [m.card.expiry, entry.expiresAt ? (expiryDate ?? m.never) : m.noExpiry],
                      [m.card.lastLogin, dateLabel(entry.lastLoginAt, m.never)],
                      [m.card.lastActivity, dateLabel(entry.lastActivityAt, m.never)],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className="flex items-start justify-between gap-3 border-t border-zinc-800 py-2 first:border-t-0"
                      >
                        <dt className="shrink-0 text-zinc-500">{label}</dt>
                        <dd className="min-w-0 text-right font-bold text-zinc-100">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </article>
              );
            })}
          </div>
        )}
      </AdminTile>

      <AdminTechInfo summary={m.roleTableSummary}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left">
            <thead className="text-zinc-500">
              <tr>
                {[m.columns.role, m.columns.users, m.columns.billing, m.columns.aiOps, m.columns.support, m.columns.destructive].map(
                  (label) => (
                    <th key={label} className="px-2 py-1.5 font-medium">
                      {label}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {roleRows.map(([role, ...levels]) => (
                <tr key={role} className="border-t border-zinc-800">
                  <td className="px-2 py-2 font-bold text-white">{role}</td>
                  {levels.map((level, index) => (
                    <td key={`${role}-${index}`} className="px-2 py-2">
                      {m.level[level]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 flex items-start gap-2 text-zinc-500">
          <LifeBuoy className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {m.envNote}
        </p>
      </AdminTechInfo>
    </div>
  );
}

export async function AdminAccessPanel({ access }: { access: ConfiguredAdminAccess[] }) {
  const m = await getAdminMessages(adminAccessMessages);
  return <AdminAccessView access={access} m={m} />;
}
