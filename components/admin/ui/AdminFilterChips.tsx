import Link from "next/link";

export type AdminFilterChip = {
  key: string;
  label: React.ReactNode;
  href: string;
  active: boolean;
  /** A small number beside the label, for example how many rows it holds. */
  count?: React.ReactNode;
  testId?: string;
};

/**
 * A row of filter chips that are links, so a filtered view is a URL: it
 * survives a reload and can be pasted into a ticket. The active chip is
 * inverted (`aria-current`), which reads in both console themes because the
 * neutral palette mirrors.
 *
 * It holds no state and no behaviour; the page decides which chip is active
 * from the same query it reads the rows with.
 */
export function AdminFilterChips({
  label,
  chips,
  className = "",
}: {
  /** The accessible name of the group. */
  label: string;
  chips: readonly AdminFilterChip[];
  className?: string;
}) {
  return (
    <nav aria-label={label} className={`flex flex-wrap items-center gap-2 ${className}`}>
      {chips.map((chip) => (
        <Link
          key={chip.key}
          href={chip.href}
          data-testid={chip.testId}
          aria-current={chip.active ? "true" : undefined}
          className={`inline-flex min-h-8 items-center gap-2 whitespace-nowrap rounded-full px-3 text-xs font-bold transition ${
            chip.active
              ? "bg-zinc-100 text-zinc-900"
              : "border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
          }`}
        >
          {chip.label}
          {chip.count !== undefined ? (
            <span className={`font-mono tabular-nums ${chip.active ? "text-zinc-600" : "text-zinc-500"}`}>
              {chip.count}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}
