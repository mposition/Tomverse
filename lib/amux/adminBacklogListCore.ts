export const AMUX_BACKLOG_PAGE_SIZE = 50;

export function amuxBacklogSearch(value: string | string[] | undefined) {
  const search = (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
  return { search, valid: search.length <= 128 && /^[A-Za-z0-9-]*$/.test(search) };
}

export function amuxBacklogPage(value: string | string[] | undefined) {
  const input = Array.isArray(value) ? value[0] : value;
  const page = input && /^\d{1,7}$/.test(input) ? Number(input) : 1;
  return Math.max(1, page);
}

export function amuxBacklogWhere(search: string) {
  return {
    archivedAt: null,
    status: "backlog",
    ...(search ? { OR: [
      { sourceKey: { contains: search, mode: "insensitive" as const } },
      { id: { contains: search, mode: "insensitive" as const } },
    ] } : {}),
  };
}

export function amuxBacklogHref(search: string, page = 1) {
  const query = new URLSearchParams({ tab: "list" });
  if (search) query.set("cardNumber", search);
  if (page > 1) query.set("page", String(page));
  return `/admin/amux-backlog?${query}`;
}

export function amuxBacklogSummary(title: string | null) {
  const summary = title?.replace(/\s+/g, " ").trim().slice(0, 240) || null;
  return summary && !/^card [a-f0-9]{16}$/i.test(summary) ? summary : null;
}
